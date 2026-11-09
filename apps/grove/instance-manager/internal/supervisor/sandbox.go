// Where a child runs: as which user, and inside which cgroup v2 leaf of this agent's delegated tree.

package supervisor

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
)

// Sandbox confines each child to a user that is not this agent and a cgroup leaf of its own. The
// zero value confines nothing, which is what a development box runs.
type Sandbox struct {
	UID, GID int
	// The cgroup v2 directory systemd delegated to this agent's unit; empty is no cgroup.
	CgroupRoot string
	MemoryMax  int64
	PidsMax    int
}

// The leaf this agent moves itself into, since a cgroup holding processes cannot delegate controllers.
const agentLeaf = "agent"

// Enabled reports whether anything is confined at all.
func (s Sandbox) Enabled() bool {
	return s.UID != 0 || s.CgroupRoot != ""
}

// Claim drops what a child must not inherit, then moves this agent into its own leaf and turns on
// the controllers every child's leaf is limited by, the order the no-internal-processes rule demands.
func (s Sandbox) Claim() error {
	if !s.Enabled() {
		return nil
	}
	if err := supported(); err != nil {
		return err
	}
	if s.CgroupRoot == "" {
		return nil
	}
	return s.claim()
}

func (s Sandbox) claim() error {
	leaf := filepath.Join(s.CgroupRoot, agentLeaf)
	if err := os.Mkdir(leaf, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("make %s: %w", leaf, err)
	}
	if err := write(filepath.Join(leaf, "cgroup.procs"), strconv.Itoa(os.Getpid())); err != nil {
		return err
	}
	return write(filepath.Join(s.CgroupRoot, "cgroup.subtree_control"), "+memory +pids")
}

// Yield turns the controllers off again as this agent exits, since systemd attaches the next run to
// the unit's own cgroup and the kernel refuses that while they are on; the next Claim restores them.
func (s Sandbox) Yield() error {
	if s.CgroupRoot == "" {
		return nil
	}
	return write(filepath.Join(s.CgroupRoot, "cgroup.subtree_control"), "-memory -pids")
}

// leaf makes one instance's cgroup and writes its limits, answering its directory.
func (s Sandbox) leaf(instanceID string) (string, error) {
	dir := s.leafDir(instanceID)
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", fmt.Errorf("make %s: %w", dir, err)
	}
	if err := s.limit(dir); err != nil {
		return "", err
	}
	return dir, nil
}

// limit writes one leaf's bounds, which a survivor needs again whenever its agent comes back.
func (s Sandbox) limit(dir string) error {
	if err := write(filepath.Join(dir, "memory.max"), strconv.FormatInt(s.MemoryMax, 10)); err != nil {
		return err
	}
	return write(filepath.Join(dir, "pids.max"), strconv.Itoa(s.PidsMax))
}

// reclaim re-applies a survivor's bounds, which an agent restart may have dropped with its controllers.
func (s Sandbox) reclaim(instanceID string) error {
	if s.CgroupRoot == "" {
		return nil
	}
	return s.limit(s.leafDir(instanceID))
}

// release ends whatever is left in an instance's leaf and removes it, once its child has gone.
func (s Sandbox) release(instanceID string) error {
	if s.CgroupRoot == "" {
		return nil
	}
	dir := s.leafDir(instanceID)
	// cgroup.kill reaches a grandchild the child left behind, which no signal to one pid would.
	_ = write(filepath.Join(dir, "cgroup.kill"), "1")
	if err := os.Remove(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", dir, err)
	}
	return nil
}

func (s Sandbox) leafDir(instanceID string) string {
	return filepath.Join(s.CgroupRoot, "game-"+instanceID)
}

func write(path, value string) error {
	if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

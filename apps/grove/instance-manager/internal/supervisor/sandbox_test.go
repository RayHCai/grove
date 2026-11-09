package supervisor

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

const sandboxed = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

func read(t *testing.T, path string) string {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

// A directory standing in for the delegated cgroup: every write the kernel would take lands here.
func cgroupFor(t *testing.T) Sandbox {
	t.Helper()
	return Sandbox{UID: 10002, GID: 10002, CgroupRoot: t.TempDir(), MemoryMax: 1 << 30, PidsMax: 256}
}

// The agent leaves its own cgroup before turning controllers on, which the kernel otherwise refuses.
func TestClaimMovesTheAgentToALeafAndEnablesTheControllers(t *testing.T) {
	s := cgroupFor(t)
	if err := s.claim(); err != nil {
		t.Fatalf("claim: %v", err)
	}

	if got := read(t, filepath.Join(s.CgroupRoot, agentLeaf, "cgroup.procs")); got != strconv.Itoa(os.Getpid()) {
		t.Errorf("agent leaf: got %q, want this pid", got)
	}
	if got := read(t, filepath.Join(s.CgroupRoot, "cgroup.subtree_control")); got != "+memory +pids" {
		t.Errorf("subtree_control: got %q", got)
	}
	// A second run of the agent finds the leaf the first one made.
	if err := s.claim(); err != nil {
		t.Errorf("claim again: %v", err)
	}

	// On the way out the controllers go off, or systemd cannot attach the next run to the unit.
	if err := s.Yield(); err != nil {
		t.Fatalf("Yield: %v", err)
	}
	if got := read(t, filepath.Join(s.CgroupRoot, "cgroup.subtree_control")); got != "-memory -pids" {
		t.Errorf("subtree_control after Yield: got %q", got)
	}
}

func TestEveryChildsLeafCarriesItsBounds(t *testing.T) {
	s := cgroupFor(t)

	dir, err := s.leaf(sandboxed)
	if err != nil {
		t.Fatalf("leaf: %v", err)
	}
	if got := read(t, filepath.Join(dir, "memory.max")); got != "1073741824" {
		t.Errorf("memory.max: got %q", got)
	}
	if got := read(t, filepath.Join(dir, "pids.max")); got != "256" {
		t.Errorf("pids.max: got %q", got)
	}

	// A survivor's bounds are written again under the next agent, which may have lost them.
	if err := os.Remove(filepath.Join(dir, "pids.max")); err != nil {
		t.Fatalf("drop pids.max: %v", err)
	}
	if err := s.reclaim(sandboxed); err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if got := read(t, filepath.Join(dir, "pids.max")); got != "256" {
		t.Errorf("pids.max after reclaim: got %q", got)
	}

	// cgroup.kill reaches whatever the child left behind; a real leaf is then removable.
	_ = s.release(sandboxed)
	if got := read(t, filepath.Join(dir, "cgroup.kill")); got != "1" {
		t.Errorf("cgroup.kill: got %q, want 1", got)
	}
}

// A development box confines nothing and writes nothing.
func TestTheZeroSandboxConfinesNothing(t *testing.T) {
	var s Sandbox
	if s.Enabled() {
		t.Fatal("the zero sandbox reads as enabled")
	}
	if err := s.Claim(); err != nil {
		t.Errorf("Claim: %v", err)
	}
	if err := s.Yield(); err != nil {
		t.Errorf("Yield: %v", err)
	}
	if err := s.reclaim(sandboxed); err != nil {
		t.Errorf("reclaim: %v", err)
	}
	if err := s.release(sandboxed); err != nil {
		t.Errorf("release: %v", err)
	}
}

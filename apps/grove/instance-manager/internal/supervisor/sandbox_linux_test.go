//go:build linux

package supervisor

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A real child in a real sandbox: run where systemd's delegation can be stood in for, which is a
// cgroup v2 directory this process may write and a uid it may spawn as, and skipped elsewhere.
func TestTheSandboxConfinesARealChild(t *testing.T) {
	root := os.Getenv("GROVE_SANDBOX_TEST_ROOT")
	uid, _ := strconv.Atoi(os.Getenv("GROVE_SANDBOX_TEST_UID"))
	if root == "" || uid == 0 {
		t.Skip("needs GROVE_SANDBOX_TEST_ROOT, a delegated cgroup v2 directory, and GROVE_SANDBOX_TEST_UID")
	}

	s := Sandbox{UID: uid, GID: uid, CgroupRoot: root, MemoryMax: 256 << 20, PidsMax: 64}
	if err := s.Claim(); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("find this test binary: %v", err)
	}

	logs := NewRing(256)
	child, err := NewExecLauncher(self, s).Start(context.Background(), Spec{
		InstanceID: sandboxed, SessionID: helperSession, Bind: "127.0.0.1:30001",
	}, logs)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitFor(t, "the child to report in", func() bool { return contains(logs.Lines(-1), "ready") })

	lines := logs.Lines(-1)
	for _, want := range []string{
		"uid " + strconv.Itoa(uid),
		// Nothing effective and nothing ambient, so the child cannot take back a uid or signal its host.
		"status CapEff:\t0000000000000000",
		"status CapAmb:\t0000000000000000",
		"cgroup 0::/" + strings.TrimPrefix(s.leafDir(sandboxed), "/sys/fs/cgroup/"),
	} {
		if !contains(lines, want) {
			t.Errorf("the child did not report %q; it said:\n%s", want, strings.Join(lines, "\n"))
		}
	}
	if got := read(t, filepath.Join(s.leafDir(sandboxed), "memory.max")); strings.TrimSpace(got) != "268435456" {
		t.Errorf("memory.max: got %q", got)
	}

	ended := make(chan error, 1)
	go func() { ended <- child.Wait() }()
	if err := child.Drain(); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	select {
	case <-ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the confined child outlived its drain")
	}
	if _, err := os.Stat(s.leafDir(sandboxed)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the leaf outlived its child: %v", err)
	}
}

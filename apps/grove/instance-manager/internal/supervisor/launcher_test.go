package supervisor

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The binary a survivor was forked from, as /proc reports argv0 of it.
const adoptedBin = "/usr/local/bin/grove-game-instance"

// The one binary this suite can be sure a box can fork is the test binary running the suite, so it
// stands in for a deploy that landed and every other case is a deploy that did not.
func TestExecReadyAnswersWhetherTheBinaryCanBeForked(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("find this test binary: %v", err)
	}

	cases := []struct {
		name     string
		bin      string
		forkable bool
	}{
		{name: "a binary that is where it was said to be", bin: self, forkable: true},
		{name: "a path the deploy left nothing at", bin: filepath.Join(t.TempDir(), "instance")},
		// A bare name is looked up on PATH rather than opened, and this is one no box installs.
		{name: "a name on no PATH entry", bin: "grove-game-instance-installed-nowhere"},
		{name: "a directory where the binary belongs", bin: t.TempDir()},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ExecReady(tc.bin)(context.Background())

			if tc.forkable && err != nil {
				t.Fatalf("%q: got %v, want ready", tc.bin, err)
			}
			if !tc.forkable && err == nil {
				t.Fatalf("%q read as ready, so this box would take every start and fail it", tc.bin)
			}
		})
	}
}

// The pid-reuse guard, which is the whole of what makes a recorded number safe to signal: a pid the
// box no longer holds, or now holds something else under, is not this agent's to take back.
func TestAdoptTakesOnlyAPidStillRunningThisBinary(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		err     error
		adopted bool
		notOurs bool
	}{
		{name: "a survivor of the last agent", raw: adoptedBin + "\x00", adopted: true},
		{name: "a pid something else now holds", raw: "/usr/sbin/sshd\x00", notOurs: true},
		{name: "a pid the kernel has nothing under", err: fs.ErrNotExist, notOurs: true},
		// A box that cannot answer is not a box saying no, so this one refusal is a bare error: its
		// caller keeps the record, and the survivor is offered again on the next boot.
		{name: "a pid this agent could not read about", err: errors.New("too many open files")},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			launcher := execLauncher{bin: adoptedBin, cmdline: func(int) ([]byte, error) {
				return []byte(tc.raw), tc.err
			}}

			child, err := launcher.Adopt(os.Getpid())

			if tc.adopted && err != nil {
				t.Fatalf("Adopt: got %v, want the survivor back", err)
			}
			if !tc.adopted && err == nil {
				t.Fatalf("pid %d was adopted, so this agent would signal whatever holds it", child.Pid())
			}
			if !tc.adopted && errors.Is(err, ErrNotOurs) != tc.notOurs {
				t.Fatalf("Adopt: got %v, want ErrNotOurs to be %t, which is the whole of what decides whether this pid's record is destroyed", err, tc.notOurs)
			}
		})
	}
}

// A survivor is polled once a second because nothing can wait on a process this agent did not fork,
// and what each of those reads means is the whole of its liveness.
func TestAnAdoptedChildEndsOnlyOnAnAnswerThisAgentGot(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		err   error
		ended bool
	}{
		{name: "a pid the kernel has nothing under", err: fs.ErrNotExist, ended: true},
		{name: "a pid something else now holds", raw: "/usr/sbin/sshd\x00", ended: true},
		{name: "a read this agent could not make", err: errors.New("too many open files")},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var reads atomic.Int32
			launcher := execLauncher{bin: adoptedBin, cmdline: func(int) ([]byte, error) {
				// The first read is the adoption itself, which every case here has to get past.
				if reads.Add(1) == 1 {
					return []byte(adoptedBin + "\x00"), nil
				}
				return []byte(tc.raw), tc.err
			}}

			child, err := launcher.Adopt(os.Getpid())
			if err != nil {
				t.Fatalf("Adopt: %v", err)
			}

			ended := make(chan struct{})
			go func() {
				_ = child.Wait()
				close(ended)
			}()

			select {
			case <-ended:
				if !tc.ended {
					t.Fatal("a live child this agent could not read about was reported ended, which hands its port to the next start and drops the record it would be adopted back from")
				}
			case <-time.After(100 * time.Millisecond):
				if tc.ended {
					t.Fatal("a child the box no longer holds was waited on for good")
				}
			}
		})
	}
}

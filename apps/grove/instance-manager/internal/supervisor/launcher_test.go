package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

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

//go:build !linux

package supervisor

import (
	"errors"
	"os/exec"
)

// A box with no cgroup v2 and no setuid spawn cannot keep the promise, so it refuses to make it.
var errUnconfinable = errors.New("a child sandbox needs linux")

func supported() error { return errUnconfinable }

func (s Sandbox) confine(_ *exec.Cmd, _ string) (func(), error) {
	if s.Enabled() {
		return nil, errUnconfinable
	}
	return func() {}, nil
}

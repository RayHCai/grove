//go:build linux

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL), which the syscall package names no constant for.
const (
	prCapAmbient         = 47
	prCapAmbientClearAll = 4
)

// supported clears this agent's ambient capabilities on every thread, keeping the effective ones a
// spawn needs: an ambient set survives execve, so a child would otherwise inherit CAP_SETUID.
func supported() error {
	// AllThreadsSyscall refuses under cgo, which fails the claim closed rather than open.
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0); errno != 0 {
		return fmt.Errorf("clear the ambient capabilities: %w", errno)
	}
	return nil
}

// confine spawns cmd as the sandbox's user, straight into the instance's leaf: CLONE_INTO_CGROUP, so
// no instruction of the child ever runs outside its bounds. The returned func closes the leaf's fd.
func (s Sandbox) confine(cmd *exec.Cmd, instanceID string) (func(), error) {
	attr := &syscall.SysProcAttr{}
	if s.UID != 0 {
		// An empty group list, or the child keeps this agent's supplementary groups and their files.
		attr.Credential = &syscall.Credential{Uid: uint32(s.UID), Gid: uint32(s.GID), Groups: []uint32{}}
	}

	done := func() {}
	if s.CgroupRoot != "" {
		dir, err := s.leaf(instanceID)
		if err != nil {
			return nil, err
		}
		f, err := os.Open(dir)
		if err != nil {
			return nil, fmt.Errorf("open %s: %w", dir, err)
		}
		attr.UseCgroupFD = true
		attr.CgroupFD = int(f.Fd())
		done = func() { _ = f.Close() }
	}

	cmd.SysProcAttr = attr
	return done, nil
}

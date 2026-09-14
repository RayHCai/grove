// How one game process is started, and the environment it is started with.

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// How often a survivor of an earlier agent is looked at, there being no wait for a process this
// one did not fork.
const adoptedPoll = time.Second

// Spec is everything one @grove/game-instance process is told, and it is told all of it at spawn.
//
// Nothing here is discovered by the child: its own config fails on a missing variable rather than
// defaulting one quietly, because every value below is a decision this agent already made.
type Spec struct {
	GameID         string
	SessionID      string
	Bind           string
	BundlePath     string
	SimConfigPath  string
	TokenSecret    []byte
	ManagerURL     string
	ManagerToken   string
	HeapLimitBytes int64
	TickBudget     time.Duration
}

// Env is the child's whole configuration, under the names apps/grove/game-instance reads.
func (s Spec) Env() []string {
	return []string{
		"GROVE_GAME_ID=" + s.GameID,
		"GROVE_SESSION_ID=" + s.SessionID,
		"GROVE_BIND=" + s.Bind,
		"GROVE_BUNDLE=" + s.BundlePath,
		"GROVE_SIM_CONFIG=" + s.SimConfigPath,
		"GAME_TOKEN_SECRET=" + string(s.TokenSecret),
		"GROVE_MANAGER_URL=" + s.ManagerURL,
		"GROVE_MANAGER_TOKEN=" + s.ManagerToken,
		"GROVE_HEAP_LIMIT_BYTES=" + strconv.FormatInt(s.HeapLimitBytes, 10),
		"GROVE_TICK_BUDGET_MS=" + strconv.FormatInt(s.TickBudget.Milliseconds(), 10),
	}
}

// Child is one running game process, as this agent handles it.
type Child interface {
	// Pid is how the next run of this agent finds this process again, nothing else about it
	// outliving the agent that forked it.
	Pid() int
	// Drain asks for the ordered ending, where the session closes and its last saves are written.
	Drain() error
	// Kill ends it now, for a child that did not answer the drain.
	Kill() error
	// Wait blocks until it exits, and reports how it went.
	Wait() error
}

// ErrNotOurs is the one adoption failure that settles anything: the kernel answered, and what it
// answered is that nothing this agent forked is under that pid.
var ErrNotOurs = errors.New("the pid is not this agent's child")

// Launcher is the seam that makes this service testable at all — a fake here is what lets the
// suite drive supervision without forking a real binary.
type Launcher interface {
	Start(ctx context.Context, spec Spec, logs io.Writer) (Child, error)
	// Adopt takes a process an earlier run of this agent left running back under this one, and
	// wraps ErrNotOurs only where it read that the pid holds no child of this agent's.
	Adopt(pid int) (Child, error)
}

type execLauncher struct {
	bin string
	// What the kernel says is running under a pid — a seam because no suite can arrange a /proc
	// that is there but unreadable, which is the case a survivor's life depends on.
	cmdline func(pid int) ([]byte, error)
}

// NewExecLauncher runs the real grove-game-instance binary at bin.
func NewExecLauncher(bin string) Launcher {
	return execLauncher{bin: bin, cmdline: procCmdline}
}

// ExecReady reports whether bin is something this box can fork at all, which a box whose last
// deploy left the binary missing or unrunnable is not.
func ExecReady(bin string) func(context.Context) error {
	return func(context.Context) error {
		// exec.LookPath asks exactly what Start will ask, and is the only spelling of the question
		// that is right on a fleet box and on a developer's Windows machine both.
		_, err := exec.LookPath(bin)
		return err
	}
}

func (l execLauncher) Start(_ context.Context, spec Spec, logs io.Writer) (Child, error) {
	// Deliberately not exec.CommandContext: an agent shutting down must not SIGKILL a session that
	// is mid-drain, and the context here only bounds the spawn.
	cmd := exec.Command(l.bin)
	// The child inherits nothing. A box holds other services' variables, and this is the one
	// process on it running creator code.
	cmd.Env = spec.Env()
	cmd.Stdout = logs
	cmd.Stderr = logs

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", l.bin, err)
	}
	return &execChild{cmd: cmd}, nil
}

func (l execLauncher) Adopt(pid int) (Child, error) {
	ours, err := l.owns(pid)
	// Only a pid the kernel has nothing under has ended; every other read failure is this agent
	// going blind for a moment, and its caller keeps the record rather than forgetting a survivor.
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("pid %d is gone: %w", pid, ErrNotOurs)
	}
	if err != nil {
		return nil, fmt.Errorf("read pid %d: %w", pid, err)
	}
	if !ours {
		return nil, fmt.Errorf("pid %d is not a %s: %w", pid, l.bin, ErrNotOurs)
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		return nil, fmt.Errorf("find pid %d: %w", pid, err)
	}
	return &adoptedChild{proc: proc, gone: func() bool { return l.gone(pid) }}, nil
}

// A pid outlives the process that held it, so what the kernel says is running under that number is
// the only evidence a survivor is this agent's child — and a box without /proc has none.
func (l execLauncher) owns(pid int) (bool, error) {
	raw, err := l.cmdline(pid)
	if err != nil {
		return false, err
	}
	argv0, _, _ := strings.Cut(string(raw), "\x00")
	return argv0 == l.bin, nil
}

// Only a pid the kernel has nothing under has ended; every other read failure is this agent going
// blind for a moment, and calling that an ending would free a live child's port, its slot and the
// record it would be adopted back from.
func (l execLauncher) gone(pid int) bool {
	ours, err := l.owns(pid)
	if err != nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	return !ours
}

func procCmdline(pid int) ([]byte, error) {
	return os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
}

type execChild struct{ cmd *exec.Cmd }

func (c *execChild) Pid() int { return c.cmd.Process.Pid }

// SIGINT, not SIGTERM: the child hangs its drain off ctrl_c, and any other signal ends the session
// with its last batch of saves still in memory.
func (c *execChild) Drain() error {
	return c.cmd.Process.Signal(os.Interrupt)
}

func (c *execChild) Kill() error {
	return c.cmd.Process.Kill()
}

func (c *execChild) Wait() error {
	return c.cmd.Wait()
}

// adoptedChild is a process this agent took over rather than forked, so the pid is its whole hold
// on one: no pipe to its output, and no exit status coming back.
type adoptedChild struct {
	proc *os.Process
	gone func() bool
}

func (c *adoptedChild) Pid() int { return c.proc.Pid }

func (c *adoptedChild) Drain() error { return c.proc.Signal(os.Interrupt) }

func (c *adoptedChild) Kill() error { return c.proc.Kill() }

func (c *adoptedChild) Wait() error {
	for !c.gone() {
		time.Sleep(adoptedPoll)
	}
	return errors.New("the adopted process is gone, and its ending went to the agent that forked it")
}

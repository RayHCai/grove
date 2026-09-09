// How one game process is started, and the environment it is started with.

package supervisor

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// Spec is everything one @grove/game-instance process is told, and it is told all of it at spawn.
//
// Nothing here is discovered by the child: its own config fails on a missing variable rather than
// defaulting one quietly, because every value below is a decision this agent already made.
type Spec struct {
	GameID         string
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
	// Drain asks for the ordered ending, where the session closes and its last saves are written.
	Drain() error
	// Kill ends it now, for a child that did not answer the drain.
	Kill() error
	// Wait blocks until it exits, and reports how it went.
	Wait() error
}

// Launcher is the seam that makes this service testable at all — a fake here is what lets the
// suite drive supervision without forking a real binary.
type Launcher interface {
	Start(ctx context.Context, spec Spec, logs io.Writer) (Child, error)
}

type execLauncher struct{ bin string }

// NewExecLauncher runs the real grove-game-instance binary at bin.
func NewExecLauncher(bin string) Launcher {
	return execLauncher{bin: bin}
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

type execChild struct{ cmd *exec.Cmd }

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

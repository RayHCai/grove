package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// A fake child is a process that was never forked: it is alive until something ends it, and the
// fake prober answers for it the way a real one answers for a real port.
type fakeChild struct {
	mu      sync.Mutex
	alive   bool
	players int
	drained bool
	killed  bool

	exit chan struct{}
	once sync.Once
}

func (c *fakeChild) Drain() error {
	c.mu.Lock()
	c.drained = true
	c.mu.Unlock()
	c.die()
	return nil
}

func (c *fakeChild) Kill() error {
	c.mu.Lock()
	c.killed = true
	c.mu.Unlock()
	c.die()
	return nil
}

func (c *fakeChild) Wait() error {
	<-c.exit
	return nil
}

func (c *fakeChild) die() {
	c.mu.Lock()
	c.alive = false
	c.mu.Unlock()
	c.once.Do(func() { close(c.exit) })
}

func (c *fakeChild) living() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.alive
}

type fakeLauncher struct {
	mu      sync.Mutex
	started int
	specs   []Spec
	byPort  map[string]*fakeChild
	inOrder []*fakeChild
	writers []io.Writer
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{byPort: make(map[string]*fakeChild)}
}

func (l *fakeLauncher) Start(_ context.Context, spec Spec, logs io.Writer) (Child, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	child := &fakeChild{alive: true, exit: make(chan struct{})}
	l.started++
	l.specs = append(l.specs, spec)
	l.inOrder = append(l.inOrder, child)
	l.writers = append(l.writers, logs)
	l.byPort[portOf(spec.Bind)] = child

	return child, nil
}

func (l *fakeLauncher) at(addr string) *fakeChild {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.byPort[portOf(addr)]
}

func (l *fakeLauncher) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.started
}

func (l *fakeLauncher) child(i int) *fakeChild {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inOrder[i]
}

func (l *fakeLauncher) logsOf(i int) io.Writer {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.writers[i]
}

func (l *fakeLauncher) spec(i int) Spec {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.specs[i]
}

func portOf(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return port
}

// A child is reachable exactly while it is alive, which is what a refused connection means on a box.
type fakeProber struct{ launcher *fakeLauncher }

func (p fakeProber) Probe(_ context.Context, addr string) (Vitals, error) {
	child := p.launcher.at(addr)
	if child == nil || !child.living() {
		return Vitals{}, errors.New("connection refused")
	}

	child.mu.Lock()
	defer child.mu.Unlock()
	return Vitals{Players: child.players}, nil
}

type fakePorts struct {
	mu   sync.Mutex
	next int
}

func (p *fakePorts) Take() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.next++
	return 30000 + p.next, nil
}

func newTestRegistry(max int) (*Registry, *fakeLauncher) {
	launcher := newFakeLauncher()

	return New(Options{
		Launcher: launcher,
		Prober:   fakeProber{launcher: launcher},
		Ports:    &fakePorts{},
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),

		MaxInstances: max,
		LogLines:     4,
		// The shortest grace that is still a grace: a probe that fails here has failed for good,
		// and nothing in a test is waiting on a real boot.
		StartGrace:  time.Nanosecond,
		StopTimeout: time.Second,
		Retention:   time.Hour,
		TokenSecret: []byte(strings.Repeat("s", 32)),
	}), launcher
}

func request(i int) Request {
	return Request{
		GameID:        "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		SessionID:     fmt.Sprintf("%08d-1111-4111-8111-111111111111", i),
		BundlePath:    "/srv/bundles/sim.js",
		SimConfigPath: "/srv/bundles/sim.json",
		ManagerURL:    "http://game-manager:4001",
		ManagerToken:  "session-scoped",
	}
}

func startN(t *testing.T, r *Registry, n int) []View {
	t.Helper()

	views := make([]View, 0, n)
	for i := range n {
		view, err := r.Start(context.Background(), request(i))
		if err != nil {
			t.Fatalf("Start %d: %v", i, err)
		}
		views = append(views, view)
	}
	return views
}

// A child is reaped on its own goroutine, so what this box knows about a dead one arrives shortly
// after it died rather than at the moment it did.
func waitFor(t *testing.T, what string, holds func() bool) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if holds() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartRefusesPastTheCap(t *testing.T) {
	cases := []struct {
		name string
		cap  int
	}{
		{name: "one session at a time", cap: 1},
		{name: "a small box", cap: 2},
		{name: "the default box", cap: 8},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, launcher := newTestRegistry(tc.cap)
			startN(t, registry, tc.cap)

			_, err := registry.Start(context.Background(), request(tc.cap))
			if !errors.Is(err, ErrAtCapacity) {
				t.Fatalf("past the cap: got %v, want ErrAtCapacity", err)
			}
			// Refused before the fork, or the cap is a report rather than a cap.
			if launcher.count() != tc.cap {
				t.Errorf("processes forked: got %d, want %d", launcher.count(), tc.cap)
			}
			if registry.Running() != tc.cap {
				t.Errorf("running: got %d, want %d", registry.Running(), tc.cap)
			}
		})
	}
}

// A slot an ending session gave back is a slot the next one may have.
func TestStoppingOneFreesItsSlot(t *testing.T) {
	registry, _ := newTestRegistry(1)
	view := startN(t, registry, 1)[0]

	if err := registry.Stop(context.Background(), view.InstanceID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := registry.Start(context.Background(), request(1)); err != nil {
		t.Fatalf("Start after Stop: %v", err)
	}
}

func TestStopDrainsRatherThanKills(t *testing.T) {
	registry, launcher := newTestRegistry(2)
	view := startN(t, registry, 1)[0]

	if err := registry.Stop(context.Background(), view.InstanceID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	child := launcher.child(0)
	child.mu.Lock()
	defer child.mu.Unlock()
	if !child.drained {
		t.Error("the child was never asked to drain")
	}
	if child.killed {
		t.Error("the child was killed, and its last saves went with it")
	}
}

func TestStopIsUnknownTwice(t *testing.T) {
	registry, _ := newTestRegistry(1)
	view := startN(t, registry, 1)[0]

	if err := registry.Stop(context.Background(), view.InstanceID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := registry.Stop(context.Background(), view.InstanceID); !errors.Is(err, ErrUnknown) {
		t.Errorf("second Stop: got %v, want ErrUnknown", err)
	}
	if _, err := registry.Get(view.InstanceID); !errors.Is(err, ErrUnknown) {
		t.Errorf("Get after Stop: got %v, want ErrUnknown", err)
	}
}

func TestPollReadsEachChild(t *testing.T) {
	cases := []struct {
		name string
		kill bool
		want contract.InstanceState
	}{
		{name: "a child that answers is healthy", kill: false, want: contract.InstanceHealthy},
		{name: "a child that died is unhealthy", kill: true, want: contract.InstanceUnhealthy},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, launcher := newTestRegistry(2)
			view := startN(t, registry, 1)[0]

			if view.State != contract.InstanceStarting {
				t.Errorf("a fresh instance: got %q, want starting", view.State)
			}
			if tc.kill {
				launcher.child(0).die()
				waitFor(t, "the dead child to be reaped", func() bool { return len(registry.Live()) == 0 })
			}

			registry.Poll(context.Background())

			polled, err := registry.Get(view.InstanceID)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if polled.State != tc.want {
				t.Errorf("state: got %q, want %q", polled.State, tc.want)
			}
			if polled.Port != view.Port {
				t.Errorf("port: got %d, want %d", polled.Port, view.Port)
			}
		})
	}
}

// A game-instance that died took its world with it, so nothing here brings one back — however many
// times this box looks at it.
func TestADeadChildIsNeverRestarted(t *testing.T) {
	registry, launcher := newTestRegistry(2)
	view := startN(t, registry, 1)[0]
	launcher.child(0).die()
	waitFor(t, "the dead child to be reaped", func() bool { return len(registry.Live()) == 0 })

	for range 5 {
		registry.Poll(context.Background())
	}

	if launcher.count() != 1 {
		t.Fatalf("processes forked: got %d, want 1", launcher.count())
	}
	polled, err := registry.Get(view.InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if polled.State != contract.InstanceUnhealthy {
		t.Errorf("state: got %q, want unhealthy", polled.State)
	}
}

func TestLiveReportsOnlyTheProcessesThisBoxHolds(t *testing.T) {
	registry, launcher := newTestRegistry(3)
	views := startN(t, registry, 3)
	launcher.child(1).die()

	waitFor(t, "the dead child to be reaped", func() bool { return len(registry.Live()) == 2 })
	registry.Poll(context.Background())

	for _, report := range registry.Live() {
		if report.InstanceID == views[1].InstanceID {
			t.Errorf("the dead child is still reported live: %s", report.InstanceID)
		}
		if !report.State.Valid() {
			t.Errorf("state %q is not one the fleet accepts", report.State)
		}
	}
	// The dead one stays listed, because its last lines are the account of why it ended.
	if len(registry.List()) != 3 {
		t.Errorf("listed: got %d, want 3", len(registry.List()))
	}
}

func TestAHealthyChildReportsItsPlayers(t *testing.T) {
	registry, launcher := newTestRegistry(1)
	view := startN(t, registry, 1)[0]

	child := launcher.child(0)
	child.mu.Lock()
	child.players = 7
	child.mu.Unlock()

	registry.Poll(context.Background())

	polled, err := registry.Get(view.InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if polled.Players != 7 {
		t.Errorf("players: got %d, want 7", polled.Players)
	}
}

func TestTheChildIsToldEverything(t *testing.T) {
	registry, launcher := newTestRegistry(1)
	startN(t, registry, 1)

	spec := launcher.spec(0)
	environment := map[string]string{}
	for _, entry := range spec.Env() {
		name, value, _ := strings.Cut(entry, "=")
		environment[name] = value
	}

	// apps/grove/game-instance discovers none of these: a missing one is a session that never boots.
	wanted := []string{
		"GROVE_GAME_ID", "GROVE_BIND", "GROVE_BUNDLE", "GROVE_SIM_CONFIG", "GAME_TOKEN_SECRET",
		"GROVE_MANAGER_URL", "GROVE_MANAGER_TOKEN", "GROVE_HEAP_LIMIT_BYTES", "GROVE_TICK_BUDGET_MS",
	}
	for _, name := range wanted {
		if environment[name] == "" {
			t.Errorf("%s is unset in the child's environment", name)
		}
	}
	if len(spec.Env()) != len(wanted) {
		t.Errorf("the child was given %d variables, want %d", len(spec.Env()), len(wanted))
	}
	if _, _, err := net.SplitHostPort(environment["GROVE_BIND"]); err != nil {
		t.Errorf("GROVE_BIND %q is not an address: %v", environment["GROVE_BIND"], err)
	}
}

func TestARetriedStartReusesTheSessionsProcess(t *testing.T) {
	registry, launcher := newTestRegistry(4)

	first, err := registry.Start(context.Background(), request(0))
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	second, err := registry.Start(context.Background(), request(0))
	if err != nil {
		t.Fatalf("retried Start: %v", err)
	}

	if second.InstanceID != first.InstanceID {
		t.Errorf("instance id: got %q, want the first %q", second.InstanceID, first.InstanceID)
	}
	if launcher.started != 1 {
		t.Errorf("processes forked: got %d, want 1 — a second world for one session", launcher.started)
	}
}

func TestAGiveUpMidStopLeavesTheChildAccountedFor(t *testing.T) {
	registry, launcher := newTestRegistry(1)
	view := startN(t, registry, 1)[0]

	// A caller that hangs up before the drain finishes. The child must still be reachable through
	// the registry afterwards, or its port belongs to a process nothing can name.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := registry.Stop(ctx, view.InstanceID); !errors.Is(err, context.Canceled) {
		t.Errorf("Stop with a dead context: got %v, want context.Canceled", err)
	}
	if _, err := registry.Get(view.InstanceID); err != nil {
		t.Errorf("Get after an abandoned Stop: got %v, want the instance still listed", err)
	}

	// The teardown outlived the caller, so the process itself is going down regardless.
	child := launcher.inOrder[0]
	deadline := time.Now().Add(2 * time.Second)
	for child.living() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if child.living() {
		t.Error("the child outlived a Stop whose caller gave up")
	}
}

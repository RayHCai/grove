package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/bundles"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// A fake child is a process that was never forked: it is alive until something ends it, and the
// fake prober answers for it the way a real one answers for a real port.
type fakeChild struct {
	pid int

	mu      sync.Mutex
	alive   bool
	players int
	drained bool
	killed  bool

	exit chan struct{}
	once sync.Once
}

func (c *fakeChild) Pid() int { return c.pid }

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
	byPid   map[int]*fakeChild
	inOrder []*fakeChild
	writers []io.Writer
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{byPort: make(map[string]*fakeChild), byPid: make(map[int]*fakeChild)}
}

func (l *fakeLauncher) Start(_ context.Context, spec Spec, logs io.Writer) (Child, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.started++
	child := &fakeChild{pid: 4000 + l.started, alive: true, exit: make(chan struct{})}
	l.specs = append(l.specs, spec)
	l.inOrder = append(l.inOrder, child)
	l.writers = append(l.writers, logs)
	l.byPort[portOf(spec.Bind)] = child
	l.byPid[child.pid] = child

	return child, nil
}

// The same box under a later agent: the process is still running under that pid, and the one that
// forked it is not there to say so.
func (l *fakeLauncher) Adopt(pid int) (Child, error) {
	l.mu.Lock()
	child, held := l.byPid[pid]
	l.mu.Unlock()

	if !held || !child.living() {
		return nil, fmt.Errorf("pid %d is not a game process: %w", pid, ErrNotOurs)
	}
	return child, nil
}

// A launcher that cannot adopt, under a failure the caller is handed as-is.
type refusingLauncher struct {
	*fakeLauncher
	err error
}

func (l refusingLauncher) Adopt(int) (Child, error) { return nil, l.err }

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

// A child is reachable exactly while alive, which is what a refused connection means here.
type fakeProber struct{ launcher *fakeLauncher }

func (p fakeProber) Probe(_ context.Context, addr string) (Vitals, string, error) {
	child := p.launcher.at(addr)
	if child == nil || !child.living() {
		return Vitals{}, "probe-id", errors.New("connection refused")
	}

	child.mu.Lock()
	defer child.mu.Unlock()
	return Vitals{Players: child.players}, "probe-id", nil
}

// A kernel that counts upward and, like the real one, offers any number nothing is bound to — so
// what keeps two children off one port is the issued set, not the fake.
type fakePorts struct {
	mu       sync.Mutex
	next     int
	issued   map[int]struct{}
	released []int
}

func newFakePorts() *fakePorts {
	return &fakePorts{issued: make(map[int]struct{})}
}

func (p *fakePorts) Take() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for range 32 {
		p.next++
		port := 30000 + p.next
		if _, held := p.issued[port]; held {
			continue
		}
		p.issued[port] = struct{}{}
		return port, nil
	}
	return 0, errors.New("every port this fake offers is already issued")
}

func (p *fakePorts) Hold(port int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.issued[port] = struct{}{}
}

func (p *fakePorts) Release(port int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.issued, port)
	p.released = append(p.released, port)
}

func (p *fakePorts) gaveBack() []int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.released)
}

// A launcher on a box whose last deploy left nothing to fork.
type brokenLauncher struct{}

func (brokenLauncher) Start(context.Context, Spec, io.Writer) (Child, error) {
	return nil, errors.New("start grove-game-instance: no such file or directory")
}

func (brokenLauncher) Adopt(pid int) (Child, error) {
	return nil, fmt.Errorf("pid %d is not a game process: %w", pid, ErrNotOurs)
}

// The options every test shares, which are the ones a real value would only make the suite slower
// for.
func testOptions(max int) Options {
	return Options{
		Ports:   newFakePorts(),
		Bundles: fakeBundles{},
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),

		MaxInstances: max,
		LogLines:     4,
		// The shortest grace that is still a grace: a probe that fails here has failed for good,
		// and nothing in a test is waiting on a real boot.
		StartGrace:  time.Nanosecond,
		StopTimeout: time.Second,
		Retention:   time.Hour,
		TokenSecret: []byte(strings.Repeat("s", 32)),
	}
}

func newTestRegistry(max int) (*Registry, *fakeLauncher) {
	launcher := newFakeLauncher()
	return registryOver(launcher, "", max), launcher
}

// registryOver is this box under its next agent: the same processes still running on it, the same
// records written down about them, and a registry that has heard of neither.
func registryOver(launcher *fakeLauncher, stateDir string, max int) *Registry {
	opts := testOptions(max)
	opts.Launcher = launcher
	opts.Prober = fakeProber{launcher: launcher}
	opts.StateDir = stateDir

	return New(opts)
}

// fakeBundles is a box that already holds every version, so a start here costs no download.
//
// The real one is covered by its own suite: what the cases below are about is what happens to a
// process once it exists, and a registry that fetched over HTTP would only be slower at it.
type fakeBundles struct{}

func (fakeBundles) Fetch(context.Context, contract.BundleSet) (bundles.Paths, error) {
	return bundles.Paths{Bundle: "/srv/bundles/sim.js", SimConfig: "/srv/bundles/sim.json"}, nil
}

// refusingBundles is a box that cannot get the code, which is a session it must not claim to hold.
type refusingBundles struct{}

func (refusingBundles) Fetch(context.Context, contract.BundleSet) (bundles.Paths, error) {
	return bundles.Paths{}, errors.New("the edge refused the connection")
}

const testRevision = 7

func request(i int) Request {
	return Request{
		InstanceID: fmt.Sprintf("%08d-2222-4222-8222-222222222222", i),
		GameID:     "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		SessionID:  fmt.Sprintf("%08d-1111-4111-8111-111111111111", i),
		Revision:   testRevision,
		Bundles: contract.BundleSet{
			Server: contract.BundleRef{
				Side: contract.SideServer, Hash: strings.Repeat("a", 64),
				URL: "https://cdn.grove.test/a.js", ByteLength: 4096,
			},
			Client: contract.BundleRef{
				Side: contract.SideClient, Hash: strings.Repeat("b", 64),
				URL: "https://cdn.grove.test/b.js", ByteLength: 2048,
			},
			SimConfig: contract.ConfigRef{
				Hash: strings.Repeat("c", 64),
				URL:  "https://cdn.grove.test/c.json", ByteLength: 142,
			},
			SyncedHash: strings.Repeat("d", 64),
		},
		ManagerURL: "http://game-manager:4001",
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
		"GROVE_GAME_ID", "GROVE_SESSION_ID", "GROVE_BIND", "GROVE_BUNDLE", "GROVE_SIM_CONFIG",
		"GAME_TOKEN_SECRET", "GROVE_MANAGER_URL", "GROVE_MANAGER_TOKEN", "GROVE_HEAP_LIMIT_BYTES",
		"GROVE_TICK_BUDGET_MS",
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
	// A value that is merely set is a session the child refuses every ticket for.
	if environment["GROVE_SESSION_ID"] != request(0).SessionID {
		t.Errorf("GROVE_SESSION_ID: got %q, want %q", environment["GROVE_SESSION_ID"], request(0).SessionID)
	}
	if environment["GROVE_GAME_ID"] != request(0).GameID {
		t.Errorf("GROVE_GAME_ID: got %q, want %q", environment["GROVE_GAME_ID"], request(0).GameID)
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

// A redeploy leaves its children running, so the agent that comes back has to find them again: one
// that started empty would offer slots this box does not have, and route new players past worlds
// that are still being played.
func TestARestartAdoptsTheChildrenItLeftRunning(t *testing.T) {
	dir := t.TempDir()
	launcher := newFakeLauncher()
	views := startN(t, registryOver(launcher, dir, 2), 2)

	second := registryOver(launcher, dir, 2)
	if err := second.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	if second.Running() != 2 {
		t.Errorf("running after the restart: got %d, want 2", second.Running())
	}
	if _, err := second.Start(context.Background(), request(9)); !errors.Is(err, ErrAtCapacity) {
		t.Errorf("a start on the full box: got %v, want ErrAtCapacity", err)
	}

	for _, want := range views {
		adopted, err := second.Get(want.InstanceID)
		if err != nil {
			t.Fatalf("Get the adopted %s: %v", want.InstanceID, err)
		}
		if adopted.SessionID != want.SessionID {
			t.Errorf("session: got %q, want %q", adopted.SessionID, want.SessionID)
		}
		if adopted.Port != want.Port {
			t.Errorf("port: got %d, want %d", adopted.Port, want.Port)
		}
	}

	// A survivor is this agent's to poll and to stop, or it was only listed rather than adopted.
	second.Poll(context.Background())
	polled, err := second.Get(views[0].InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if polled.State != contract.InstanceHealthy {
		t.Errorf("state: got %q, want healthy", polled.State)
	}
	if err := second.Stop(context.Background(), views[0].InstanceID); err != nil {
		t.Fatalf("Stop the adopted instance: %v", err)
	}
	if launcher.child(0).living() {
		t.Error("the adopted child outlived a stop, so the drain reached nothing")
	}
}

// A port belongs to the survivor holding it across the restart too. The agent comes back knowing
// only what it wrote down, and a survivor that has not bound its port yet — this agent is restarted
// five seconds after it dies — is one the kernel would offer that number for again.
func TestAnAdoptedChildKeepsItsPort(t *testing.T) {
	dir := t.TempDir()
	launcher := newFakeLauncher()
	survivors := startN(t, registryOver(launcher, dir, 3), 2)

	second := registryOver(launcher, dir, 3)
	if err := second.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	next, err := second.Start(context.Background(), request(9))
	if err != nil {
		t.Fatalf("Start after the restart: %v", err)
	}

	for _, held := range survivors {
		if next.Port == held.Port {
			t.Errorf("a new child was sent to port %d, which %s is still on", next.Port, held.InstanceID)
		}
	}

	// And the port the new child was issued survives an adopted one ending, which releases only its
	// own number.
	if err := second.Stop(context.Background(), survivors[0].InstanceID); err != nil {
		t.Fatalf("Stop the adopted instance: %v", err)
	}
	ports := second.opts.Ports.(*fakePorts)
	if slices.Contains(ports.gaveBack(), next.Port) {
		t.Errorf("port %d was given back while its child was still running", next.Port)
	}
}

// A pid this box no longer holds is a record to forget: adopting one would hold a slot against a
// process that has ended, and a later stop would signal whatever now answers to that number. A pid
// this agent could not read about is not that, and forgetting one loses a live session for good.
func TestARecordIsForgottenOnlyWhereItsPidIsProvablyNotThisAgentsChild(t *testing.T) {
	cases := []struct {
		name string
		err  error
		kept bool
	}{
		{name: "a pid the kernel has nothing under", err: fmt.Errorf("pid 4041 is gone: %w", ErrNotOurs)},
		{name: "a pid this agent could not read about", err: errors.New("read pid 4041: too many open files"), kept: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			state := store{dir: dir}
			// The port the fake kernel offers first, so a new child is sent to it unless this
			// survivor's number was held back.
			survivor := record{
				InstanceID: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
				GameID:     "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
				SessionID:  "00000000-1111-4111-8111-111111111111",
				PID:        4041,
				Port:       30001,
				StartedAt:  time.Now().Add(-time.Hour),
			}
			if err := state.put(survivor); err != nil {
				t.Fatalf("write a record: %v", err)
			}

			launcher := newFakeLauncher()
			opts := testOptions(2)
			opts.Launcher = refusingLauncher{fakeLauncher: launcher, err: tc.err}
			opts.Prober = fakeProber{launcher: launcher}
			opts.StateDir = dir
			registry := New(opts)

			if err := registry.Adopt(); err != nil {
				t.Fatalf("Adopt: %v", err)
			}

			if registry.Running() != 0 {
				t.Errorf("running: got %d, want 0", registry.Running())
			}
			if len(registry.List()) != 0 {
				t.Errorf("listed: got %d, want 0", len(registry.List()))
			}

			held, err := state.all()
			if err != nil {
				t.Fatalf("read the records back: %v", err)
			}
			if tc.kept && len(held) != 1 {
				t.Fatalf("records left: got %d, want the record kept, since a session may still be running under that pid and nothing else would ever find it", len(held))
			}
			if !tc.kept && len(held) != 0 {
				t.Fatalf("records left: got %d, want 0", len(held))
			}

			next, err := registry.Start(context.Background(), request(9))
			if err != nil {
				t.Fatalf("Start after the adoption: %v", err)
			}
			if tc.kept && next.Port == survivor.Port {
				t.Errorf("a new child was sent to port %d, which the unread survivor may still hold", next.Port)
			}
			if !tc.kept && next.Port != survivor.Port {
				t.Errorf("port: got %d, want %d back in circulation once its process was known gone", next.Port, survivor.Port)
			}
		})
	}
}

// Nothing reaps a port no process ever took, so a failed spawn is the one path that has to hand it
// back itself.
func TestAFailedSpawnGivesItsPortBack(t *testing.T) {
	ports := newFakePorts()
	opts := testOptions(1)
	opts.Launcher = brokenLauncher{}
	opts.Prober = fakeProber{launcher: newFakeLauncher()}
	opts.Ports = ports

	registry := New(opts)
	if _, err := registry.Start(context.Background(), request(0)); err == nil {
		t.Fatal("a start with no binary to fork was accepted")
	}

	if got := ports.gaveBack(); len(got) != 1 || got[0] != 30001 {
		t.Errorf("ports given back: got %v, want [30001]", got)
	}
}

// A prober that answers only once every child is waiting on it, which a serial poll can never
// satisfy.
type gatheringProber struct {
	arrived chan struct{}
	release chan struct{}
}

func (p gatheringProber) Probe(context.Context, string) (Vitals, string, error) {
	p.arrived <- struct{}{}
	<-p.release
	return Vitals{}, "probe-id", nil
}

// One wedged child must not age every other reading in the beat, which is what a cycle costing one
// probe timeout per child does.
func TestPollAsksEveryChildAtOnce(t *testing.T) {
	const children = 4

	prober := gatheringProber{
		arrived: make(chan struct{}, children),
		release: make(chan struct{}),
	}
	opts := testOptions(children)
	opts.Launcher = newFakeLauncher()
	opts.Prober = prober
	registry := New(opts)
	startN(t, registry, children)

	polled := make(chan struct{})
	go func() {
		registry.Poll(context.Background())
		close(polled)
	}()

	for asked := range children {
		select {
		case <-prober.arrived:
		case <-time.After(2 * time.Second):
			close(prober.release)
			t.Fatalf("children asked at once: got %d, want %d", asked, children)
		}
	}
	close(prober.release)

	// Poll stays synchronous to its caller, because a beat reports what the last one left behind.
	select {
	case <-polled:
	case <-time.After(2 * time.Second):
		t.Fatal("Poll never returned")
	}
}

// The player was handed this id with the placement, so a second one minted here would name a
// process nobody was told to dial.
func TestTheInstanceKeepsTheIdItWasPlacedUnder(t *testing.T) {
	registry, _ := newTestRegistry(2)

	started, err := registry.Start(context.Background(), request(3))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if started.InstanceID != request(3).InstanceID {
		t.Errorf("instance id: got %q, want the placed %q", started.InstanceID, request(3).InstanceID)
	}
	got, err := registry.Get(request(3).InstanceID)
	if err != nil {
		t.Fatalf("Get under the placed id: %v", err)
	}
	if got.SessionID != request(3).SessionID {
		t.Errorf("session id: got %q, want %q", got.SessionID, request(3).SessionID)
	}
}

// Nothing upstream holds GAME_TOKEN_SECRET on the placement path, so the bearer the child presents
// to @grove/game-manager is one this agent signs, and it has to outlast a join ticket.
func TestTheChildIsGivenAStoreBearerThisAgentMinted(t *testing.T) {
	registry, launcher := newTestRegistry(1)
	startN(t, registry, 1)

	environment := map[string]string{}
	for _, entry := range launcher.spec(0).Env() {
		name, value, _ := strings.Cut(entry, "=")
		environment[name] = value
	}

	secret := []byte(strings.Repeat("s", 32))
	claims, err := token.Verify(environment["GROVE_MANAGER_TOKEN"], secret, token.AudGameManager, time.Now().Unix())
	if err != nil {
		t.Fatalf("@grove/game-manager refuses the bearer: %v", err)
	}
	if claims.SessionID != request(0).SessionID || claims.GameID != request(0).GameID {
		t.Errorf("the bearer names %s/%s", claims.GameID, claims.SessionID)
	}
	// A store bearer belongs to the process, not to anyone in it.
	if claims.PlayerID != "" {
		t.Errorf("the bearer names a player: %q", claims.PlayerID)
	}
	// A world outlives the 60 seconds a join ticket is good for, and its saves go through this.
	if _, err := token.Verify(environment["GROVE_MANAGER_TOKEN"], secret, token.AudGameManager,
		time.Now().Add(time.Hour).Unix()); err != nil {
		t.Errorf("the bearer is spent an hour into the session: %v", err)
	}
}

// The heartbeat carries these verbatim, and a report without a port is a session no player reaches.
func TestALiveReportCarriesThePortItsChildBound(t *testing.T) {
	registry, _ := newTestRegistry(2)
	views := startN(t, registry, 2)

	live := registry.Live()
	if len(live) != len(views) {
		t.Fatalf("live reports: got %d, want %d", len(live), len(views))
	}
	byID := map[string]int{}
	for _, view := range views {
		byID[view.InstanceID] = view.Port
	}
	for _, report := range live {
		if report.Port == 0 {
			t.Errorf("%s is reported on no port", report.InstanceID)
		}
		if report.Port != byID[report.InstanceID] {
			t.Errorf("port: got %d, want the bound %d", report.Port, byID[report.InstanceID])
		}
	}
}

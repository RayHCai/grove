package supervisor

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// The shortest drain poll that is still a poll, so a test waits on the drain rather than on a
// ticker sized to a real box.
const testDrainPoll = 5 * time.Millisecond

// A second game on the same box, which a push of the first has no business ending.
const otherGameID = "0d4f2b18-6c3a-4f5e-8b90-1a2c3d4e5f60"

func drainingRegistry(deadline time.Duration, stateDir string) (*Registry, *fakeLauncher) {
	launcher := newFakeLauncher()
	return nextAgent(launcher, deadline, stateDir), launcher
}

// nextAgent is this box under its next run of the agent: the same processes still running on it, the
// same records written down about them, and a registry that has heard of neither.
func nextAgent(launcher *fakeLauncher, deadline time.Duration, stateDir string) *Registry {
	opts := testOptions(4)
	opts.Launcher = launcher
	opts.Prober = fakeProber{launcher: launcher}
	opts.StateDir = stateDir
	opts.DrainDeadline = deadline
	opts.DrainPoll = testDrainPoll

	return New(opts)
}

func setPlayers(child *fakeChild, players int) {
	child.mu.Lock()
	defer child.mu.Unlock()
	child.players = players
}

func stateOf(t *testing.T, r *Registry, id string) contract.InstanceState {
	t.Helper()

	view, err := r.Get(id)
	if err != nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	return view.State
}

func drainRecord(t *testing.T, dir, id string) record {
	t.Helper()

	held, err := store{dir: dir}.all()
	if err != nil {
		t.Fatalf("read the records back: %v", err)
	}
	for _, rec := range held {
		if rec.InstanceID == id {
			return rec
		}
	}
	t.Fatalf("no record names %s", id)
	return record{}
}

func TestRedeployDrainsEveryWorldOfOneGameAndNamesThemInOrder(t *testing.T) {
	registry, _ := drainingRegistry(time.Minute, "")
	pushed := startN(t, registry, 3)

	elsewhere := request(3)
	elsewhere.GameID = otherGameID
	other, err := registry.Start(context.Background(), elsewhere)
	if err != nil {
		t.Fatalf("Start the other game: %v", err)
	}

	marked := registry.Redeploy(request(0).GameID, time.Now())

	want := make([]string, 0, len(pushed))
	for _, view := range pushed {
		want = append(want, view.InstanceID)
	}
	slices.Sort(want)
	if !slices.Equal(marked, want) {
		t.Fatalf("marked: got %v, want %v", marked, want)
	}
	// Stated outright as well, since these ids happen to be started in the order they sort in and a
	// map walked in any order at all would match the line above once in six.
	if !slices.IsSorted(marked) {
		t.Errorf("marked: got %v, want them in order", marked)
	}

	for _, view := range pushed {
		if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceDraining {
			t.Errorf("state of %s: got %q, want %q", view.InstanceID, got, contract.InstanceDraining)
		}
	}
	if got := stateOf(t, registry, other.InstanceID); got != contract.InstanceStarting {
		t.Errorf("state of the other game's world: got %q, want %q", got, contract.InstanceStarting)
	}
}

func TestADrainingWorldEndsOnlyOnceItsLastPlayerHasLeft(t *testing.T) {
	cases := []struct {
		name    string
		players int
		ends    bool
	}{
		{name: "a match still being played", players: 2},
		{name: "a world whose last player has left", players: 0, ends: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, launcher := drainingRegistry(time.Minute, "")
			view := startN(t, registry, 1)[0]
			child := launcher.child(0)

			setPlayers(child, 3)
			registry.Poll(context.Background())
			registry.Redeploy(request(0).GameID, time.Now())

			setPlayers(child, tc.players)
			for range 10 {
				registry.Poll(context.Background())
				time.Sleep(testDrainPoll)
			}

			if !tc.ends {
				if !child.living() {
					t.Fatalf("the world ended with %d players still in it", tc.players)
				}
				if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceDraining {
					t.Errorf("state: got %q, want %q", got, contract.InstanceDraining)
				}
				return
			}

			waitFor(t, "the emptied world to end", func() bool { return !child.living() })
			child.mu.Lock()
			defer child.mu.Unlock()
			if !child.drained {
				t.Error("the emptied world was never asked to drain")
			}
			if child.killed {
				t.Error("the emptied world was killed, and its last saves went with it")
			}
		})
	}
}

// A roster frozen at the moment of the drain never reaches zero, so the world would sit there until
// its deadline and every push would end in a deadline rather than in an empty world.
func TestAProbeRefreshesADrainingRosterWithoutCallingItHealthyAgain(t *testing.T) {
	registry, launcher := drainingRegistry(time.Minute, "")
	view := startN(t, registry, 1)[0]
	child := launcher.child(0)

	setPlayers(child, 4)
	registry.Poll(context.Background())
	registry.Redeploy(request(0).GameID, time.Now())

	setPlayers(child, 2)
	registry.Poll(context.Background())

	polled, err := registry.Get(view.InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if polled.Players != 2 {
		t.Errorf("players: got %d, want 2", polled.Players)
	}
	// A drain is this agent's own decision, and a healthy answer from the child is not a vote on it.
	if polled.State != contract.InstanceDraining {
		t.Errorf("state: got %q, want %q", polled.State, contract.InstanceDraining)
	}
}

// A world redeployed between its spawn and its first player reads as empty only because nothing has
// asked it yet.
func TestAWorldNoProbeHasAnsweredForIsNotTakenAsEmpty(t *testing.T) {
	registry, launcher := drainingRegistry(time.Minute, "")
	view := startN(t, registry, 1)[0]
	child := launcher.child(0)

	registry.Redeploy(request(0).GameID, time.Now())
	time.Sleep(10 * testDrainPoll)

	if !child.living() {
		t.Fatal("a world ended before any probe had ever answered for it")
	}
	if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceDraining {
		t.Errorf("state: got %q, want %q", got, contract.InstanceDraining)
	}

	// The same zero, once a probe has actually returned it, does end the world — or the wait above
	// proves only that the drain loop never ran.
	registry.Poll(context.Background())
	waitFor(t, "the probed-empty world to end", func() bool { return !child.living() })
}

func TestADrainThatNeverEmptiesEndsOnItsDeadline(t *testing.T) {
	const deadline = 40 * time.Millisecond

	registry, launcher := drainingRegistry(deadline, "")
	startN(t, registry, 1)
	child := launcher.child(0)

	setPlayers(child, 1)
	registry.Poll(context.Background())

	began := time.Now()
	registry.Redeploy(request(0).GameID, began)
	waitFor(t, "the drain to run out", func() bool { return !child.living() })

	if waited := time.Since(began); waited < deadline {
		t.Errorf("the world ended after %v, want no sooner than the %v deadline", waited, deadline)
	}
	child.mu.Lock()
	defer child.mu.Unlock()
	if !child.drained {
		t.Error("the world was taken without being asked to drain")
	}
}

func TestAStopDuringADrainDoesNotWaitOutTheDeadline(t *testing.T) {
	registry, launcher := drainingRegistry(time.Hour, "")
	view := startN(t, registry, 1)[0]
	child := launcher.child(0)

	setPlayers(child, 3)
	registry.Poll(context.Background())
	registry.Redeploy(request(0).GameID, time.Now())

	stopped := make(chan error, 1)
	go func() { stopped <- registry.Stop(context.Background(), view.InstanceID) }()

	// Bounded rather than waited on: an operator asking for the process back is the one thing that
	// collapses a drain sized to a whole match, and without it this hangs the suite.
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("Stop during a drain: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stop is still waiting on a drain deadline an hour away")
	}

	if child.living() {
		t.Error("Stop returned on a child that is still running")
	}
	child.mu.Lock()
	defer child.mu.Unlock()
	if !child.drained {
		t.Error("the child was never asked to drain")
	}
}

// The budget runs from when the drain began and not from when this run of the agent picked it up,
// or an agent restarted often enough would hand a world a fresh deadline every time and never end it.
func TestADrainResumesABudgetAlreadySpent(t *testing.T) {
	const deadline = time.Minute

	registry, launcher := drainingRegistry(deadline, "")
	startN(t, registry, 1)
	child := launcher.child(0)

	// A player who is never leaving, so nothing but the deadline can end this world.
	setPlayers(child, 1)
	registry.Poll(context.Background())

	registry.Redeploy(request(0).GameID, time.Now().Add(-2*deadline))
	waitFor(t, "a drain whose budget was already spent to end", func() bool { return !child.living() })
}

// A world that was ending when the last agent went comes back as one that is still ending: re-armed
// as starting, the router would offer it to a joiner the child is already refusing.
func TestAdoptTakesADrainingWorldBackAsDraining(t *testing.T) {
	const deadline = time.Minute

	dir := t.TempDir()
	before, launcher := drainingRegistry(deadline, dir)
	view := startN(t, before, 1)[0]
	child := launcher.child(0)

	setPlayers(child, 1)
	before.Poll(context.Background())

	// Stamped rather than redeployed, so the drain under test is the one the next agent resumes and
	// not one this registry is already running down.
	if err := (store{dir: dir}).draining(view.InstanceID, time.Now().Add(-2*deadline)); err != nil {
		t.Fatalf("stamp the drain: %v", err)
	}

	after := nextAgent(launcher, deadline, dir)
	if err := after.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	if got := stateOf(t, after, view.InstanceID); got != contract.InstanceDraining {
		t.Fatalf("state after adoption: got %q, want %q", got, contract.InstanceDraining)
	}
	waitFor(t, "the resumed drain to end the world", func() bool { return !child.living() })
}

func TestASecondRedeployLeavesTheFirstDrainsDeadlineAlone(t *testing.T) {
	dir := t.TempDir()
	registry, _ := drainingRegistry(time.Minute, dir)
	view := startN(t, registry, 1)[0]

	began := time.Now()
	registry.Redeploy(request(0).GameID, began)

	stamped := drainRecord(t, dir, view.InstanceID)
	if !stamped.DrainingSince.Equal(began) {
		t.Fatalf("drainingSince: got %v, want %v", stamped.DrainingSince, began)
	}
	// The pid and the port are the whole of what makes a record adoptable, and the drain stamp has
	// no business restating either.
	if stamped.PID == 0 || stamped.Port != view.Port || stamped.SessionID != view.SessionID {
		t.Errorf("record: got pid %d port %d session %q, want the one Start wrote with port %d and session %q",
			stamped.PID, stamped.Port, stamped.SessionID, view.Port, view.SessionID)
	}

	// A game pushed every few minutes must not hand its worlds a whole new budget each time, or one
	// that has been ending all afternoon would never finish.
	registry.Redeploy(request(0).GameID, began.Add(10*time.Minute))

	again := drainRecord(t, dir, view.InstanceID)
	if !again.DrainingSince.Equal(began) {
		t.Errorf("drainingSince after a second push: got %v, want the first %v", again.DrainingSince, began)
	}
}

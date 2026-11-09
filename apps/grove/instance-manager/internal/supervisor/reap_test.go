package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// reapingRegistry is a box whose worlds end unasked on clocks a test can outwait.
func reapingRegistry(t *testing.T, tune func(*Options)) (*Registry, *fakeLauncher) {
	t.Helper()

	launcher := newFakeLauncher()
	opts := testOptions(4)
	opts.Launcher = launcher
	opts.Prober = fakeProber{launcher: launcher}
	opts.DrainPoll = testDrainPoll
	opts.DrainDeadline = time.Minute
	opts.ReapIdle = time.Hour
	tune(&opts)
	return New(opts), launcher
}

func pollFor(r *Registry, d time.Duration) {
	for end := time.Now().Add(d); time.Now().Before(end); {
		r.Poll(context.Background())
		time.Sleep(testDrainPoll)
	}
}

func TestAWorldNobodyIsInEndsOnceItHasBeenIdleLongEnough(t *testing.T) {
	cases := []struct {
		name    string
		players int
		ends    bool
	}{
		{name: "an empty world", players: 0, ends: true},
		{name: "a world still being played", players: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, launcher := reapingRegistry(t, func(o *Options) { o.ReapIdle = 30 * time.Millisecond })
			startN(t, registry, 1)
			child := launcher.child(0)
			setPlayers(child, tc.players)

			pollFor(registry, 120*time.Millisecond)

			if !tc.ends {
				if !child.living() {
					t.Fatal("a world with players in it was ended as idle")
				}
				return
			}
			waitFor(t, "the idle world to end", func() bool { return !child.living() })
			child.mu.Lock()
			defer child.mu.Unlock()
			if !child.drained || child.killed {
				t.Errorf("drained %t, killed %t: want the ordinary drain, so its last saves land", child.drained, child.killed)
			}
		})
	}
}

// A world this box retires itself is marked first and held for the notice, so the beat carrying the
// mark reaches the router before the process it would have sent a joiner to is gone.
func TestAnIdleWorldIsMarkedAndHeldForTheNoticeBeforeItEnds(t *testing.T) {
	const notice = 300 * time.Millisecond

	registry, launcher := reapingRegistry(t, func(o *Options) {
		o.ReapIdle = 10 * time.Millisecond
		o.DrainNotice = notice
	})
	view := startN(t, registry, 1)[0]
	child := launcher.child(0)

	pollFor(registry, 60*time.Millisecond)
	if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceDraining {
		t.Fatalf("state: got %q, want the idle world marked draining", got)
	}
	if !child.living() {
		t.Fatal("the idle world ended before the beat carrying its mark could go out")
	}
	waitFor(t, "the idle world to end after its notice", func() bool { return !child.living() })
}

// A wedged process never empties, so a run of unanswered probes takes it down whatever it holds.
func TestAWorldThatStopsAnsweringIsTakenDown(t *testing.T) {
	registry, launcher := reapingRegistry(t, func(o *Options) { o.ReapUnhealthyProbes = 3 })
	view := startN(t, registry, 1)[0]
	child := launcher.child(0)
	setPlayers(child, 4)
	registry.Poll(context.Background())

	child.mu.Lock()
	child.deaf = true
	child.mu.Unlock()

	registry.Poll(context.Background())
	registry.Poll(context.Background())
	if !child.living() {
		t.Fatal("a world was taken down before it had failed the probes it is allowed")
	}
	if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceUnhealthy {
		t.Errorf("state: got %q, want unhealthy while it fails", got)
	}

	registry.Poll(context.Background())
	waitFor(t, "the wedged world to be taken down", func() bool { return !child.living() })
}

// A world whose bearer is about to die must have drained before its saves start failing.
func TestAWorldNearTheEndOfItsStoreBearerDrains(t *testing.T) {
	dir := t.TempDir()
	const margin = time.Hour

	registry, launcher := reapingRegistry(t, func(o *Options) {
		o.ReapTokenMargin = margin
		o.StateDir = dir
	})
	req := request(0)
	req.StoreTokenExpiresAt = contract.Timestamp(time.Now().Add(margin + 150*time.Millisecond))
	view, err := registry.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	child := launcher.child(0)
	setPlayers(child, 1)

	registry.Poll(context.Background())
	if got := stateOf(t, registry, view.InstanceID); got == contract.InstanceDraining {
		t.Fatal("a world was drained an hour and more before its bearer ends")
	}

	time.Sleep(200 * time.Millisecond)
	registry.Poll(context.Background())
	if got := stateOf(t, registry, view.InstanceID); got != contract.InstanceDraining {
		t.Fatalf("state: got %q, want draining inside the margin", got)
	}
	if drainRecord(t, dir, view.InstanceID).DrainingSince.IsZero() {
		t.Error("the drain was not written down, so a restart would re-arm the world")
	}

	setPlayers(child, 0)
	pollFor(registry, 30*time.Millisecond)
	waitFor(t, "the world to end once its last player left", func() bool { return !child.living() })
}

func TestAStartWhoseBearerWouldDieFirstIsRefused(t *testing.T) {
	cases := []struct {
		name    string
		expires string
	}{
		{name: "inside the margin", expires: contract.Timestamp(time.Now().Add(time.Minute))},
		{name: "already dead", expires: contract.Timestamp(time.Now().Add(-time.Minute))},
		{name: "not a time at all", expires: "soon"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, launcher := newTestRegistry(2)
			req := request(0)
			req.StoreTokenExpiresAt = tc.expires

			if _, err := registry.Start(context.Background(), req); !errors.Is(err, ErrShortLived) {
				t.Fatalf("got %v, want %v", err, ErrShortLived)
			}
			if launcher.count() != 0 {
				t.Error("a world was forked whose saves would fail before it could drain")
			}
		})
	}
}

// A start whose caller already gave up is a world nobody would ever join.
func TestAStartWhoseCallerHasGoneForksNothing(t *testing.T) {
	registry, launcher := newTestRegistry(2)
	gone, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := registry.Start(gone, request(0)); err == nil {
		t.Fatal("a start for a caller that had gone was accepted")
	}
	if launcher.count() != 0 {
		t.Errorf("processes forked: got %d, want none", launcher.count())
	}
}

// A push drains the worlds on other versions and leaves the one already running it alone.
func TestARedeployLeavesTheWorldsAlreadyOnItsRevision(t *testing.T) {
	registry, _ := drainingRegistry(time.Minute, "")
	older := startN(t, registry, 1)[0]
	req := request(1)
	req.Revision = pushedRevision
	current, err := registry.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if marked := registry.Redeploy(req.GameID, pushedRevision, time.Now()); !slices.Equal(marked, []string{older.InstanceID}) {
		t.Fatalf("marked: got %v, want only the world on revision %d", marked, testRevision)
	}
	if got := stateOf(t, registry, current.InstanceID); got == contract.InstanceDraining {
		t.Error("the world already on the pushed revision was drained")
	}

	// Naming no revision is every world of the game, which is what an operator asks to clear one.
	if marked := registry.Redeploy(req.GameID, 0, time.Now()); !slices.Contains(marked, current.InstanceID) {
		t.Errorf("marked: got %v, want every world of the game", marked)
	}
}

// A survivor whose bearer has no recorded end may lose its saves at any moment, so it only drains.
func TestASurvivorWithNoKnownBearerEndOnlyDrains(t *testing.T) {
	dir := t.TempDir()
	launcher := newFakeLauncher()
	survivor := startN(t, registryOver(launcher, dir, 2), 1)[0]

	path := filepath.Join(dir, survivor.InstanceID+stateExt)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the record: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode the record: %v", err)
	}
	delete(fields, "storeTokenExpiresAt")
	stripped, _ := json.Marshal(fields)
	if err := os.WriteFile(path, stripped, 0o640); err != nil {
		t.Fatalf("write the record: %v", err)
	}

	second := registryOver(launcher, dir, 2)
	if err := second.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if got := stateOf(t, second, survivor.InstanceID); got != contract.InstanceDraining {
		t.Errorf("state: got %q, want draining", got)
	}
}

// The proxy routes a player only to a world that still has a process behind it.
func TestPortNamesOnlyALiveWorld(t *testing.T) {
	registry, launcher := newTestRegistry(2)
	view := startN(t, registry, 1)[0]

	if port, ok := registry.Port(view.InstanceID); !ok || port != view.Port {
		t.Fatalf("a live world: got %d %t, want %d", port, ok, view.Port)
	}
	if _, ok := registry.Port("6f1e5a3c-0b2d-4c8e-9a71-000000000000"); ok {
		t.Error("an unknown world named a port")
	}

	launcher.child(0).die()
	waitFor(t, "the dead world to drop off", func() bool {
		_, ok := registry.Port(view.InstanceID)
		return !ok
	})
}

// Watch is what drives every reading and every reap on a box, until its context ends.
func TestWatchPollsUntilItsContextEnds(t *testing.T) {
	registry, launcher := reapingRegistry(t, func(*Options) {})
	view := startN(t, registry, 1)[0]
	setPlayers(launcher.child(0), 3)

	ctx, stop := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		registry.Watch(ctx, testDrainPoll)
		close(stopped)
	}()

	waitFor(t, "a poll to read the roster", func() bool {
		got, err := registry.Get(view.InstanceID)
		return err == nil && got.Players == 3 && got.State == contract.InstanceHealthy
	})
	stop()
	waitFor(t, "Watch to return", func() bool {
		select {
		case <-stopped:
			return true
		default:
			return false
		}
	})
}

package joins

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	gameID   = "44444444-4444-4444-8444-444444444444"
	hostA    = "11111111-1111-4111-8111-111111111111"
	playerID = "55555555-5555-4555-8555-555555555555"
)

// The deadline is long enough that nothing here is answered by it unless a case means it to be, and
// every wait is bounded well inside it, so a line that stops answering fails naming what it owed.
const (
	joinDeadline = 5 * time.Second
	answerWithin = 2 * time.Second
)

// placer is the fleet as the line reaches it. Each player's decision is scripted: answered now,
// refused, or a start that runs until the test releases it.
type placer struct {
	mu   sync.Mutex
	seen []string
	// Players whose decision is a start, which blocks until release closes.
	starting map[string]bool
	refuse   bool
	// Closed to let every decision through; open, Decide holds the worker.
	decide  chan struct{}
	release chan struct{}

	// Decisions begun, which is how a test knows the worker holds a join.
	entered atomic.Int32
	running atomic.Int32
	most    atomic.Int32
	budgets chan time.Duration
}

func newPlacer() *placer {
	p := &placer{
		starting: map[string]bool{},
		decide:   make(chan struct{}),
		release:  make(chan struct{}),
		budgets:  make(chan time.Duration, 16),
	}
	close(p.decide)
	return p
}

func placementFor(player string) contract.Placement {
	return contract.Placement{HostID: hostA, InstanceID: player, SessionID: player, ServerURL: "wss://box:443/play/" + player}
}

func (p *placer) Decide(_ context.Context, req contract.PlacementRequest) Decision {
	p.entered.Add(1)
	<-p.decide
	p.mu.Lock()
	p.seen = append(p.seen, req.PlayerID)
	starts, refuse := p.starting[req.PlayerID], p.refuse
	p.mu.Unlock()

	switch {
	case refuse:
		return Decision{}
	case starts:
		return Decision{Start: true, Finish: func(ctx context.Context) (contract.Placement, bool) {
			deadline, _ := ctx.Deadline()
			p.budgets <- time.Until(deadline)
			now := p.running.Add(1)
			for {
				most := p.most.Load()
				if now <= most || p.most.CompareAndSwap(most, now) {
					break
				}
			}
			defer p.running.Add(-1)
			select {
			case <-p.release:
				return placementFor(req.PlayerID), true
			case <-ctx.Done():
				return contract.Placement{}, false
			}
		}}
	}
	return Decision{Placement: placementFor(req.PlayerID), Placed: true}
}

func (p *placer) order() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.seen)
}

type answered struct {
	placement contract.Placement
	err       error
}

func newLine(t *testing.T, p *placer, depth, workers int) *Line {
	t.Helper()

	l := New(Options{Placer: p, Log: slog.New(slog.DiscardHandler), Deadline: joinDeadline, Depth: depth, StartWorkers: workers})
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	go l.Run(ctx)
	return l
}

func joining(ctx context.Context, l *Line, player string) chan answered {
	answers := make(chan answered, 1)
	go func() {
		placement, err := l.Join(ctx, contract.PlacementRequest{GameID: gameID, PlayerID: player})
		answers <- answered{placement: placement, err: err}
	}()
	return answers
}

func waitFor[T any](t *testing.T, ch chan T, what string) T {
	t.Helper()

	select {
	case v := <-ch:
		return v
	case <-time.After(answerWithin):
		t.Fatalf("%s: nothing arrived within %s", what, answerWithin)
		var none T
		return none
	}
}

func eventually(t *testing.T, what string, holds func() bool) {
	t.Helper()

	for deadline := time.Now().Add(answerWithin); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if holds() {
			return
		}
	}
	t.Fatalf("%s: never held", what)
}

// Arrival order is the whole of what the line owns, and each answer reaches the caller it is for.
func TestJoinsAreDecidedInTheOrderTheyArrived(t *testing.T) {
	const joins = 8
	p := newPlacer()
	p.decide = make(chan struct{})
	l := newLine(t, p, joins, 1)

	answers := make([]chan answered, joins)
	want := make([]string, joins)
	for i := range joins {
		want[i] = fmt.Sprintf("player-%d", i)
		answers[i] = joining(context.Background(), l, want[i])
		// One at a time into the line, so arrival is a fact and not goroutine scheduling: the first is
		// held by the worker, and each after it waits behind.
		eventually(t, "the join to queue", func() bool { return p.entered.Load() == 1 && l.Waiting() == i })
	}
	close(p.decide)

	for i, ch := range answers {
		got := waitFor(t, ch, "the answer for "+want[i])
		if got.err != nil || got.placement != placementFor(want[i]) {
			t.Fatalf("%s: got %+v %v, want its own placement", want[i], got.placement, got.err)
		}
	}
	if got := p.order(); !slices.Equal(got, want) {
		t.Fatalf("decided: got %v, want %v", got, want)
	}
}

// A refused join leaves nothing behind it, and the line takes joins again once it drains.
func TestAFullLineRefusesAndTakesJoinsAgainOnceItDrains(t *testing.T) {
	p := newPlacer()
	p.decide = make(chan struct{})
	l := newLine(t, p, 2, 1)

	held := []chan answered{joining(context.Background(), l, "player-0")}
	eventually(t, "the worker to take the first join", func() bool { return p.entered.Load() == 1 })
	held = append(held, joining(context.Background(), l, "player-1"), joining(context.Background(), l, "player-2"))
	eventually(t, "the line to fill", func() bool { return l.Waiting() == 2 })

	if _, err := l.Join(context.Background(), contract.PlacementRequest{PlayerID: "player-3"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("a join past the depth: got %v, want %v", err, ErrBusy)
	}

	close(p.decide)
	for i, ch := range held {
		if got := waitFor(t, ch, fmt.Sprintf("player-%d", i)); got.err != nil {
			t.Fatalf("player-%d: %v", i, got.err)
		}
	}
	if _, err := l.Join(context.Background(), contract.PlacementRequest{PlayerID: "player-4"}); err != nil {
		t.Fatalf("a join once the line drained: %v", err)
	}
	if slices.Contains(p.order(), "player-3") {
		t.Fatal("the refused join was decided anyway")
	}
}

func TestAJoinTheFleetDeclinesIsAnsweredNoCapacity(t *testing.T) {
	p := newPlacer()
	p.refuse = true
	l := newLine(t, p, 4, 1)

	asked := time.Now()
	if _, err := l.Join(context.Background(), contract.PlacementRequest{PlayerID: playerID}); !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("got %v, want %v", err, ErrNoCapacity)
	}
	if took := time.Since(asked); took >= answerWithin {
		t.Errorf("took %s, want the fleet's own answer, not the deadline", took)
	}
}

// A cold box answering slowly holds up only the join waiting on it, never the worker deciding.
func TestAStartRunsBesideTheWorkerAndInsideTheJoinersDeadline(t *testing.T) {
	p := newPlacer()
	p.starting["slow"] = true
	l := newLine(t, p, 4, 2)

	slow := joining(context.Background(), l, "slow")
	if budget := waitFor(t, p.budgets, "the start to run"); budget <= 0 || budget > joinDeadline {
		t.Errorf("the start's budget: got %s, want what is left of the joiner's %s", budget, joinDeadline)
	}

	quick := waitFor(t, joining(context.Background(), l, "quick"), "the join behind a start")
	if quick.err != nil {
		t.Fatalf("the join behind a slow start: %v", quick.err)
	}

	close(p.release)
	if got := waitFor(t, slow, "the slow start"); got.err != nil || got.placement != placementFor("slow") {
		t.Fatalf("the slow start: got %+v %v", got.placement, got.err)
	}
}

// The pool is the bound on how many boxes are being called at once.
func TestNoMoreStartsRunAtOnceThanThePoolHolds(t *testing.T) {
	const workers = 2
	p := newPlacer()
	for i := range 5 {
		p.starting[fmt.Sprintf("player-%d", i)] = true
	}
	l := newLine(t, p, 8, workers)

	var all []chan answered
	for i := range 5 {
		all = append(all, joining(context.Background(), l, fmt.Sprintf("player-%d", i)))
	}
	for range workers {
		waitFor(t, p.budgets, "a start to run")
	}
	time.Sleep(20 * time.Millisecond)
	if most := p.most.Load(); most != workers {
		t.Fatalf("starts at once: got %d, want %d", most, workers)
	}

	close(p.release)
	for i, ch := range all {
		if got := waitFor(t, ch, fmt.Sprintf("player-%d", i)); got.err != nil {
			t.Fatalf("player-%d: %v", i, got.err)
		}
	}
}

// A start whose joiner has gone is answered to nobody, and its context says so to the start.
func TestAStartWhoseJoinerLeftIsCancelled(t *testing.T) {
	p := newPlacer()
	p.starting[playerID] = true
	l := newLine(t, p, 4, 1)

	ctx, giveUp := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer giveUp()
	if got := waitFor(t, joining(ctx, l, playerID), "the impatient join"); !errors.Is(got.err, ErrNoCapacity) {
		t.Fatalf("got %v, want %v", got.err, ErrNoCapacity)
	}
	eventually(t, "the start to see its joiner gone", func() bool { return p.running.Load() == 0 })
}

func TestRunReturnsWhenItsContextEnds(t *testing.T) {
	l := New(Options{Placer: newPlacer(), Log: slog.New(slog.DiscardHandler), Deadline: joinDeadline, Depth: 4, StartWorkers: 2})

	ctx, stop := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		l.Run(ctx)
		close(stopped)
	}()
	stop()
	waitFor(t, stopped, "Run returning")
}

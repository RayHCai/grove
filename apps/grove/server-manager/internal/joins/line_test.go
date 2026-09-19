package joins

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	gameID   = "44444444-4444-4444-8444-444444444444"
	playerID = "55555555-5555-4555-8555-555555555555"
	hostA    = "11111111-1111-4111-8111-111111111111"

	serverURL = "wss://192.0.2.1:41337/play"
)

// The deadline is long enough that nothing here is answered by it rather than by the worker, and
// every wait is bounded well inside it, so a line that stops answering fails naming what it owed.
const (
	joinDeadline = 5 * time.Second
	answerWithin = 2 * time.Second
)

// reservation is one slot handed back, which is the whole of what Release is told.
type reservation struct{ game, session string }

// placer is the fleet as the line reaches it: it records the order it was asked in, and a test that
// needs a join held mid-placement decides when that answer lands.
type placer struct {
	mu      sync.Mutex
	seen    []string
	granted map[string]contract.Placement
	refuse  bool

	// Buffered past anything a test in this file asks of it, so the worker never waits on a signal
	// nobody is watching for.
	entered  chan string
	released chan reservation

	held chan struct{}
	open bool
}

func newPlacer() *placer {
	p := &placer{
		granted:  make(map[string]contract.Placement),
		entered:  make(chan string, 16),
		released: make(chan reservation, 16),
		held:     make(chan struct{}),
	}
	p.resume()
	return p
}

// holds keeps every Place waiting for resume, which is the only way a test reaches the window where
// a caller gives up on a join the fleet is already ranking.
func (p *placer) holds() *placer {
	p.held = make(chan struct{})
	p.open = false
	return p
}

func (p *placer) refuses() *placer {
	p.refuse = true
	return p
}

// Idempotent, because the cleanup resumes a placer whose test has already released it.
func (p *placer) resume() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.open {
		return
	}
	p.open = true
	close(p.held)
}

func (p *placer) Place(_ context.Context, req contract.PlacementRequest) (contract.Placement, bool) {
	placement := contract.Placement{
		HostID:     hostA,
		InstanceID: contract.NewUUID(),
		SessionID:  contract.NewUUID(),
		ServerURL:  serverURL,
	}

	p.mu.Lock()
	p.seen = append(p.seen, req.PlayerID)
	refuse := p.refuse
	if !refuse {
		p.granted[req.PlayerID] = placement
	}
	p.mu.Unlock()

	p.entered <- req.PlayerID
	<-p.held

	if refuse {
		return contract.Placement{}, false
	}
	return placement, true
}

func (p *placer) Release(game, session string) {
	p.released <- reservation{game: game, session: session}
}

func (p *placer) order() []string {
	p.mu.Lock()
	defer p.mu.Unlock()

	return slices.Clone(p.seen)
}

func (p *placer) grantedTo(player string) contract.Placement {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.granted[player]
}

type answered struct {
	placement contract.Placement
	err       error
}

// harness is the line with the queue it was built on, because how many joins are sitting in that
// queue is the one thing a test has to know before it lets the worker touch them.
type harness struct {
	*Line
	queue  *Memory
	placer *placer
}

func newHarness(t *testing.T, lineDepth int, p *placer) *harness {
	t.Helper()

	// However a test leaves it, so a placer still holding a join leaves no worker wedged behind it.
	t.Cleanup(p.resume)

	q := NewMemory(lineDepth)
	return &harness{
		Line: New(Options{
			Queue:    q,
			Placer:   p,
			Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
			Deadline: joinDeadline,
		}),
		queue:  q,
		placer: p,
	}
}

func (h *harness) answering(t *testing.T) {
	t.Helper()

	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	go h.Run(ctx)
}

func (h *harness) joining(ctx context.Context, player string) chan answered {
	answers := make(chan answered, 1)
	go func() {
		placement, err := h.Join(ctx, request(player))
		answers <- answered{placement: placement, err: err}
	}()
	return answers
}

// waitForDepth is what makes arrival order a fact here rather than the order goroutines were run.
func (h *harness) waitForDepth(t *testing.T, want int) {
	t.Helper()

	for deadline := time.Now().Add(answerWithin); time.Now().Before(deadline); {
		if len(h.queue.jobs) == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("joins in the line: got %d, want %d", len(h.queue.jobs), want)
}

func request(player string) contract.PlacementRequest {
	return contract.PlacementRequest{GameID: gameID, PlayerID: player}
}

// waitFor takes the one value a test is waiting on, so a line that never answers fails here naming
// what it owed rather than as the suite's own timeout.
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

// Arrival order is the whole of what the line owns, and each answer goes back to the caller that
// waited for it and to no other.
func TestJoinsArePlacedInTheOrderTheyArrived(t *testing.T) {
	const joins = 8

	h := newHarness(t, joins, newPlacer())

	// Every join is in the line before the worker starts, so nothing here races to be first.
	answers := make([]chan answered, joins)
	want := make([]string, joins)
	for i := range joins {
		want[i] = fmt.Sprintf("player-%d", i)
		answers[i] = h.joining(context.Background(), want[i])
		h.waitForDepth(t, i+1)
	}

	h.answering(t)

	for i, ch := range answers {
		got := waitFor(t, ch, fmt.Sprintf("the answer for %s", want[i]))
		if got.err != nil {
			t.Fatalf("%s: got %v, want a placement", want[i], got.err)
		}
		if placed := h.placer.grantedTo(want[i]); got.placement != placed {
			t.Fatalf("%s: got %+v, want the placement made for it %+v", want[i], got.placement, placed)
		}
	}

	if got := h.placer.order(); !slices.Equal(got, want) {
		t.Fatalf("placed: got %v, want %v", got, want)
	}
}

// A refused join must leave nothing behind it: a line that took one past its cap and answered nobody
// would stay above that cap and refuse every join after it for as long as the process lived.
func TestAFullLineRefusesAndTakesJoinsAgainOnceItDrains(t *testing.T) {
	const full = 2

	h := newHarness(t, full, newPlacer().holds())
	h.answering(t)

	held := h.joining(context.Background(), "player-0")
	waitFor(t, h.placer.entered, "the first join reaching the placer")

	behind := []chan answered{
		h.joining(context.Background(), "player-1"),
		h.joining(context.Background(), "player-2"),
	}
	h.waitForDepth(t, full)

	if _, err := h.Join(context.Background(), request("player-3")); !errors.Is(err, ErrBusy) {
		t.Fatalf("a join past the depth: got %v, want %v", err, ErrBusy)
	}
	if got := len(h.queue.jobs); got != full {
		t.Fatalf("joins in the line after the refusal: got %d, want %d", got, full)
	}

	h.placer.resume()
	for i, answers := range append([]chan answered{held}, behind...) {
		if got := waitFor(t, answers, fmt.Sprintf("the answer for player-%d", i)); got.err != nil {
			t.Fatalf("player-%d: got %v, want a placement", i, got.err)
		}
	}

	if _, err := h.Join(context.Background(), request("player-4")); err != nil {
		t.Fatalf("a join once the line drained: got %v, want a placement", err)
	}
	if got := h.placer.order(); slices.Contains(got, "player-3") {
		t.Fatalf("placed: got %v, want nothing for the join the line refused", got)
	}
}

// The fleet's own refusal is the only answer a player is shown as a full game.
// A join that waited out its own deadline is answered this too, so a test that reads only the error
// would pass against a line that never reached the fleet at all.
func TestAJoinTheFleetDeclinesIsAnsweredNoCapacity(t *testing.T) {
	p := newPlacer().refuses()
	h := newHarness(t, 4, p)
	h.answering(t)

	asked := time.Now()
	if _, err := h.Join(context.Background(), request(playerID)); !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("a declined join: got %v, want %v", err, ErrNoCapacity)
	}
	if took := time.Since(asked); took >= answerWithin {
		t.Errorf("took %s, want the fleet's own answer well inside the %s deadline", took, joinDeadline)
	}

	select {
	case player := <-p.entered:
		if player != playerID {
			t.Errorf("the fleet was asked about %q, want %q", player, playerID)
		}
	default:
		t.Error("the fleet was never asked")
	}
}

// A placement committed for a caller that has already gone holds a slot no player will ever arrive
// on, so the line hands that slot straight back.
func TestAPlacementForACallerThatStoppedWaitingGoesBack(t *testing.T) {
	h := newHarness(t, 4, newPlacer().holds())
	h.answering(t)

	ctx, giveUp := context.WithCancel(context.Background())
	answers := h.joining(ctx, playerID)
	waitFor(t, h.placer.entered, "the join reaching the placer")

	// Cancelled while the fleet is mid-ranking, which is the window the slot is reserved in.
	giveUp()
	if got := waitFor(t, answers, "the abandoned join"); !errors.Is(got.err, ErrNoCapacity) {
		t.Fatalf("an abandoned join: got %v, want %v", got.err, ErrNoCapacity)
	}

	h.placer.resume()

	got := waitFor(t, h.placer.released, "the slot going back")
	want := reservation{game: gameID, session: h.placer.grantedTo(playerID).SessionID}
	if got != want {
		t.Fatalf("released: got %+v, want %+v", got, want)
	}
}

// The worker is cancelled after the listener has drained, and every handler still in that drain is
// waiting on this one goroutine to return.
func TestRunReturnsWhenItsContextEnds(t *testing.T) {
	h := newHarness(t, 4, newPlacer())

	ctx, stop := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		h.Run(ctx)
		close(stopped)
	}()

	stop()
	waitFor(t, stopped, "the worker returning")
}

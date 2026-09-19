// What a joining player waits on, and the one worker that answers it.

package joins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

var (
	// ErrBusy is this process failing to keep up, which is not the fleet being full — telling a
	// player there is no capacity while the fleet has slots free is the one wrong answer here.
	ErrBusy = errors.New("the join line is full")
	// ErrNoCapacity is the fleet's own answer, and the only one a player is shown as a full game.
	ErrNoCapacity = errors.New("no capacity")
)

// A cache that refuses a connection refuses it at once, so an unpaced retry would spend this whole
// process on a line it cannot reach.
const retryAfterFailedPop = 250 * time.Millisecond

// Placer is the decision the line stands in front of.
//
// An interface so the line holds no fleet: what it owns is the order joins are answered in, where a
// registry, a balancer and an ingress are three things it would otherwise have to know about.
type Placer interface {
	// Place answers one join, or false when nothing in the fleet qualifies.
	Place(ctx context.Context, req contract.PlacementRequest) (contract.Placement, bool)
	// Release hands back the slot a placement took, for a caller that had already stopped waiting.
	Release(gameID, sessionID string)
}

// Options is what the composition root builds a Line from.
type Options struct {
	Queue  Queue
	Placer Placer
	Log    *slog.Logger
	// How long a join may wait to be answered, which has to sit inside @grove/api's own abort or it
	// is a deadline nothing can ever reach.
	Deadline time.Duration
}

// Line is the order joins are answered in.
//
// One worker, deliberately: the placement decision is already one critical section in the registry,
// so a second worker would buy no throughput and would take the ordering away — the arrival order
// this exists to impose would become the order the runtime happened to grant a mutex in.
type Line struct {
	queue    Queue
	placer   Placer
	log      *slog.Logger
	deadline time.Duration

	mu      sync.Mutex
	waiting map[string]*waiter
}

// waiter is one caller still holding its connection open.
type waiter struct {
	// Buffered and written at most once, so a delivery never blocks the lock it is made under.
	answers chan answer
	// Set when the caller stopped waiting, under the lock a delivery takes: a placement committed
	// for a caller that has gone holds a slot until the box that took it beats.
	gone bool
}

type answer struct {
	placement contract.Placement
	placed    bool
}

// job is one join as it sits in the line.
//
// It carries no clock. Whether its caller is still there is the waiter's presence, which is one
// fact in one process rather than two machines' readings of the time.
type job struct {
	ID      string                    `json:"id"`
	Request contract.PlacementRequest `json:"request"`
}

func New(o Options) *Line {
	return &Line{
		queue:    o.Queue,
		placer:   o.Placer,
		log:      o.Log,
		deadline: o.Deadline,
		waiting:  make(map[string]*waiter),
	}
}

// Join puts one player in the line and waits for the worker to answer it.
func (l *Line) Join(ctx context.Context, req contract.PlacementRequest) (contract.Placement, error) {
	ctx, cancel := context.WithTimeout(ctx, l.deadline)
	defer cancel()

	id := contract.NewUUID()
	w := &waiter{answers: make(chan answer, 1)}

	// Registered before the push, so a worker quick enough to pop this job before Push has returned
	// still finds someone to answer.
	l.mu.Lock()
	l.waiting[id] = w
	l.mu.Unlock()
	defer l.abandon(id, w)

	encoded, err := json.Marshal(job{ID: id, Request: req})
	if err != nil {
		return contract.Placement{}, fmt.Errorf("encode the join: %w", err)
	}

	accepted, err := l.queue.Push(ctx, encoded)
	if err != nil {
		return contract.Placement{}, fmt.Errorf("push the join: %w", err)
	}
	if !accepted {
		return contract.Placement{}, ErrBusy
	}

	select {
	case a := <-w.answers:
		if !a.placed {
			return contract.Placement{}, ErrNoCapacity
		}
		return a.placement, nil
	case <-ctx.Done():
		// A join the line could not reach in time is a game a player cannot get into, and a full
		// fleet is the only shape @grove/api has for that.
		return contract.Placement{}, ErrNoCapacity
	}
}

// Run answers the line until ctx ends.
//
// Started before the listener and cancelled after it has drained: the drain waits on handlers, and
// every handler still in it is waiting on this.
func (l *Line) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}

		encoded, err := l.queue.Pop(ctx)
		switch {
		case errors.Is(err, ErrEmpty):
			continue
		case err != nil:
			if ctx.Err() != nil {
				return
			}
			l.log.Warn("the join line could not be read", "err", err)
			select {
			case <-time.After(retryAfterFailedPop):
			case <-ctx.Done():
				return
			}
			continue
		}

		l.serve(ctx, encoded)
	}
}

func (l *Line) serve(ctx context.Context, encoded []byte) {
	var j job
	if err := json.Unmarshal(encoded, &j); err != nil {
		l.log.Warn("a join in the line could not be read", "err", err)
		return
	}

	// Taken before the fleet is ranked rather than after: a join whose caller has already gone
	// costs no ranking and, more to the point, reserves no slot for nobody.
	w := l.take(j.ID)
	if w == nil {
		return
	}

	placement, placed := l.placer.Place(ctx, j.Request)
	if !placed {
		l.settle(w, answer{})
		return
	}
	if !l.settle(w, answer{placement: placement, placed: true}) {
		// The caller gave up while this was ranking, so the slot it just took is one no player is
		// going to arrive on.
		l.placer.Release(j.Request.GameID, placement.SessionID)
	}
}

// take claims the caller waiting on one job, or nothing when it is already gone.
func (l *Line) take(id string) *waiter {
	l.mu.Lock()
	defer l.mu.Unlock()

	w, ok := l.waiting[id]
	if !ok {
		return nil
	}
	delete(l.waiting, id)
	return w
}

// settle hands the answer over, or reports the caller gone so its slot can go back.
//
// Both this and abandon take the one lock, so a caller that gives up while its join is being ranked
// is either answered or counted as gone, and never both.
func (l *Line) settle(w *waiter, a answer) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if w.gone {
		return false
	}
	w.answers <- a
	return true
}

func (l *Line) abandon(id string, w *waiter) {
	l.mu.Lock()
	defer l.mu.Unlock()

	delete(l.waiting, id)
	w.gone = true
}

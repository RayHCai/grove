// Package joins is the line a joining player waits in, the one worker that decides each join in
// arrival order, and the bounded pool that carries out the decisions a box has to answer.
package joins

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

var (
	// ErrBusy is this process failing to keep up, which is not the fleet being full; telling a
	// player there is no capacity while the fleet has slots free is the one wrong answer here.
	ErrBusy = errors.New("the join line is full")
	// ErrNoCapacity is the fleet's own answer, and the only one a player is shown as a full game.
	ErrNoCapacity = errors.New("no capacity")
)

// Decision is what the worker concluded about one join.
type Decision struct {
	// The answer, when Finish is nil.
	Placement contract.Placement
	Placed    bool
	// Finish completes a decision that waits on a box, inside the joiner's own deadline.
	Finish func(ctx context.Context) (contract.Placement, bool)
	// Start says Finish calls a box, which the pool bounds; waiting on another join's start does not.
	Start bool
}

// Placer is the decision the line stands in front of. Decide never leaves the process, so the one
// worker that calls it is never held by a slow box.
type Placer interface {
	Decide(ctx context.Context, req contract.PlacementRequest) Decision
}

// Options is what the composition root builds a Line from.
type Options struct {
	Placer Placer
	Log    *slog.Logger
	// How long a join may wait to be answered, which has to sit inside @grove/api's own abort or it
	// is a deadline nothing can ever reach.
	Deadline time.Duration
	// How many joins may be waiting before the next is refused.
	Depth int
	// How many starts may be calling boxes at once.
	StartWorkers int
}

// Line is the order joins are decided in, and the pool their starts run on.
//
// One decision worker, since a second would buy no throughput and lose the arrival order; the calls
// to boxes are what is slow, and they run beside it, so one cold box holds up no other join.
type Line struct {
	placer   Placer
	log      *slog.Logger
	deadline time.Duration
	workers  int
	jobs     chan *job
	starts   chan task

	mu sync.Mutex
}

// job is one caller still holding its connection open, and when it stops waiting.
type job struct {
	req      contract.PlacementRequest
	deadline time.Time
	// Buffered and written at most once, so a delivery never blocks the lock it is made under.
	answers chan answer
	// Set when the caller stopped waiting, under the lock a delivery takes.
	gone bool
}

type answer struct {
	placement contract.Placement
	placed    bool
}

type task struct {
	job      *job
	decision Decision
}

func New(o Options) *Line {
	workers := o.StartWorkers
	if workers < 1 {
		workers = 1
	}
	return &Line{
		placer:   o.Placer,
		log:      o.Log,
		deadline: o.Deadline,
		workers:  workers,
		jobs:     make(chan *job, o.Depth),
		// As deep as the line, so a decision is never held waiting for a free start worker.
		starts: make(chan task, o.Depth),
	}
}

// Join puts one player in the line and waits for the answer.
func (l *Line) Join(ctx context.Context, req contract.PlacementRequest) (contract.Placement, error) {
	ctx, cancel := context.WithTimeout(ctx, l.deadline)
	defer cancel()

	deadline, _ := ctx.Deadline()
	j := &job{req: req, deadline: deadline, answers: make(chan answer, 1)}
	select {
	case l.jobs <- j:
	default:
		// Refused without adding, so a full line falls as the worker drains it.
		return contract.Placement{}, ErrBusy
	}
	defer l.abandon(j)

	select {
	case a := <-j.answers:
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

// Run decides the line until ctx ends, and runs the start pool beside it.
//
// Started before the listener and cancelled after it has drained: the drain waits on handlers, and
// every handler still in it is waiting on this.
func (l *Line) Run(ctx context.Context) {
	var pool sync.WaitGroup
	for range l.workers {
		pool.Add(1)
		go func() {
			defer pool.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case t := <-l.starts:
					l.finish(ctx, t)
				}
			}
		}()
	}
	defer pool.Wait()

	for {
		select {
		case <-ctx.Done():
			return
		case j := <-l.jobs:
			l.decide(ctx, j)
		}
	}
}

func (l *Line) decide(ctx context.Context, j *job) {
	// Checked before the fleet is ranked: a join whose caller has gone reserves no slot for nobody.
	if l.isGone(j) {
		return
	}
	jobCtx, cancel := context.WithDeadline(ctx, j.deadline)
	d := l.placer.Decide(jobCtx, j.req)
	cancel()

	switch {
	case d.Finish == nil:
		l.settle(j, answer{placement: d.Placement, placed: d.Placed})
	case d.Start:
		l.starts <- task{job: j, decision: d}
	default:
		go l.finish(ctx, task{job: j, decision: d})
	}
}

// finish carries one decision out inside its joiner's remaining time, so a box is never waited on
// for a player who has already been told no.
func (l *Line) finish(ctx context.Context, t task) {
	ctx, cancel := context.WithDeadline(ctx, t.job.deadline)
	defer cancel()

	placement, placed := t.decision.Finish(ctx)
	l.settle(t.job, answer{placement: placement, placed: placed})
}

func (l *Line) isGone(j *job) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return j.gone
}

// settle hands the answer over, or reports the caller gone. Both this and abandon take the one
// lock, so a caller that gives up is either answered or counted as gone, and never both.
func (l *Line) settle(j *job, a answer) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if j.gone {
		return false
	}
	j.answers <- a
	j.gone = true
	return true
}

func (l *Line) abandon(j *job) {
	l.mu.Lock()
	defer l.mu.Unlock()
	j.gone = true
}

// Waiting is how many joins sit in the line, for a test and for an operator's metric alike.
func (l *Line) Waiting() int {
	return len(l.jobs)
}

// Package joins is the line a joining player waits in, and the one worker that answers it.
package joins

import (
	"context"
	"errors"
	"strconv"
	"time"
)

// ErrEmpty is what a Pop that waited and found nothing answers, so a worker loops rather than
// reading an idle fleet as a fault.
var ErrEmpty = errors.New("no join waiting")

// Queue is the line joins wait in, in arrival order.
//
// A seam because where the line lives is a deployment's answer and not this service's: a
// development box has no cache and wants none, where a deployment with one wants a depth an
// operator can read while players are waiting in it.
type Queue interface {
	// Push puts one encoded job at the back of the line, and answers false when the line is
	// already at its depth, having added nothing — a line that accepted past its cap and then
	// refused its caller would leave a job for a worker to pop and answer nobody.
	Push(ctx context.Context, job []byte) (bool, error)
	// Pop takes the front of the line, blocking until one arrives, until ctx ends, or until its own
	// bounded wait runs out — the last answering ErrEmpty.
	Pop(ctx context.Context) ([]byte, error)
	// Close releases whatever the line is held in.
	Close()
}

// Memory is the line for a deployment with no cache.
//
// A real implementation rather than a test double: a single box running the whole fleet locally has
// nothing to share a line with, and a fake line would prove nothing about the one that ships.
type Memory struct{ jobs chan []byte }

// NewMemory holds depth joins, which is the same bound the Redis line refuses past.
func NewMemory(depth int) *Memory {
	return &Memory{jobs: make(chan []byte, depth)}
}

func (m *Memory) Push(ctx context.Context, job []byte) (bool, error) {
	select {
	case m.jobs <- job:
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	default:
		// Refused without adding, which is what makes a full line recoverable: the depth falls as
		// the worker drains it rather than staying above the cap behind entries nobody will read.
		return false, nil
	}
}

func (m *Memory) Pop(ctx context.Context) ([]byte, error) {
	select {
	case job := <-m.jobs:
		return job, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *Memory) Close() {}

// Redis is the line held in a cache, where an operator can read its depth and a restart of this
// service does not empty it.
//
// LPUSH at the head and BLPOP at the tail, so the line is first-in-first-out in the direction the
// worker reads it.
type Redis struct {
	key   string
	depth int
	// How long one BLPOP waits before answering empty, which is how often the worker rechecks the
	// context it was started under.
	wait time.Duration
	// Every command other than the pop, which holds its connection for the whole of its own wait.
	pushes *pool
	popper *conn
	dial   dialer
}

// The idle connections the pushing side keeps. A push is two commands over microseconds, so this is
// sized to concurrent joins in flight rather than to the fleet.
const idleConns = 8

// NewRedis parses the url once, so a malformed one refuses to start the service rather than failing
// on the first player who tries to join.
func NewRedis(rawURL, key string, depth int, wait time.Duration) (*Redis, error) {
	d, err := parseRedisURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &Redis{
		key:    key,
		depth:  depth,
		wait:   wait,
		pushes: newPool(d, idleConns),
		dial:   d,
	}, nil
}

// Push refuses on the depth it read rather than on the one it caused.
//
// LLEN before LPUSH, so a refused join leaves nothing behind. Two pushers that read the same length
// can overshoot the cap between them by as many as are in flight, which costs a few joins more in
// the line — where pushing first and refusing after would leave the line above its cap behind
// entries no caller is waiting on, and refuse every join after that until a worker drained them.
func (r *Redis) Push(ctx context.Context, job []byte) (bool, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(r.wait)
	}

	c, err := r.pushes.get(deadline)
	if err != nil {
		return false, err
	}

	length, err := c.do(deadline, "LLEN", r.key)
	if err != nil {
		r.pushes.discard(c)
		return false, err
	}
	if length.integer >= int64(r.depth) {
		r.pushes.put(c)
		return false, nil
	}

	if _, err := c.do(deadline, "LPUSH", r.key, string(job)); err != nil {
		r.pushes.discard(c)
		return false, err
	}
	r.pushes.put(c)
	return true, nil
}

// Pop blocks on its own connection for wait, then answers ErrEmpty so the worker rechecks ctx.
//
// BLPOP rather than a reliable move into a second list: the answer goes back over the connection
// the caller is still holding, so a join this process loses is one whose caller is gone too, and an
// entry parked for a sweeper would be one nobody could ever be told about.
func (r *Redis) Pop(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Redis reads this as whole seconds, and zero means wait forever — which would leave a worker
	// no way back to its context.
	seconds := int(r.wait.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	// Past the server's own wait, so a server that answers empty on time is not read as a timeout.
	deadline := time.Now().Add(r.wait + r.wait/2)

	if r.popper == nil {
		c, err := r.dial.dial(deadline)
		if err != nil {
			return nil, err
		}
		r.popper = c
	}

	popped, err := r.popper.do(deadline, "BLPOP", r.key, strconv.Itoa(seconds))
	if err != nil {
		// Closed rather than reused: a half-read reply would be read as the next pop's.
		r.popper.raw.Close()
		r.popper = nil
		return nil, err
	}
	// A null array is the server saying the wait ran out with the line empty.
	if popped.null || len(popped.array) != 2 {
		return nil, ErrEmpty
	}
	return popped.array[1], nil
}

func (r *Redis) Close() {
	r.pushes.closeAll()
	if r.popper != nil {
		r.popper.raw.Close()
		r.popper = nil
	}
}

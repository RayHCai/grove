// The bounded tail of one child's output.

package supervisor

import (
	"strings"
	"sync"
)

// Longer than any line a game process writes, and short enough that a child writing without a
// newline cannot grow the pending buffer without bound.
const maxLineLen = 8 * 1024

// Ring holds the most recent lines one child wrote, so an operator can read why it went unhealthy
// without shelling into the box.
type Ring struct {
	mu      sync.Mutex
	lines   []string
	next    int
	filled  bool
	pending []byte
}

// NewRing holds capacity lines, dropping the oldest to make room.
func NewRing(capacity int) *Ring {
	if capacity < 1 {
		capacity = 1
	}
	return &Ring{lines: make([]string, capacity)}
}

// Write takes the child's stdout and stderr, split into lines.
//
// It never fails and never blocks: a log buffer that could refuse a write would stall the process
// it exists to observe.
func (r *Ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, b := range p {
		if b == '\n' {
			r.flush()
			continue
		}
		r.pending = append(r.pending, b)
		if len(r.pending) >= maxLineLen {
			r.flush()
		}
	}
	return len(p), nil
}

// Add records a line this agent wrote about the child, beside the ones the child wrote itself.
func (r *Ring) Add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// A process that crashed mid-line wrote the most interesting thing in this buffer, so what it
	// left without a newline is kept rather than dropped behind the note that it ended.
	if len(r.pending) > 0 {
		r.flush()
	}
	r.push(line)
}

// Lines returns the last limit lines, oldest first, so a reader sees a failure in the order it
// happened. A negative limit is the whole buffer.
func (r *Ring) Lines(limit int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	held := r.next
	oldest := 0
	if r.filled {
		held = len(r.lines)
		oldest = r.next
	}
	if limit < 0 || limit > held {
		limit = held
	}

	out := make([]string, 0, limit)
	for i := held - limit; i < held; i++ {
		out = append(out, r.lines[(oldest+i)%len(r.lines)])
	}
	return out
}

func (r *Ring) flush() {
	// Trimmed because a child on a pipe may still write CRLF, and the carriage return would reach a
	// reader as a line that overwrites the one before it.
	r.push(strings.TrimSuffix(string(r.pending), "\r"))
	r.pending = r.pending[:0]
}

func (r *Ring) push(line string) {
	r.lines[r.next] = line
	r.next = (r.next + 1) % len(r.lines)
	if r.next == 0 {
		r.filled = true
	}
}

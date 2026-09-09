package supervisor

import (
	"fmt"
	"strings"
	"testing"
)

func TestRingKeepsTheTailOldestFirst(t *testing.T) {
	cases := []struct {
		name     string
		capacity int
		written  string
		limit    int
		want     []string
	}{
		{
			name:     "everything fits",
			capacity: 4,
			written:  "one\ntwo\n",
			limit:    -1,
			want:     []string{"one", "two"},
		},
		{
			name:     "the oldest lines are dropped",
			capacity: 3,
			written:  "one\ntwo\nthree\nfour\nfive\n",
			limit:    -1,
			want:     []string{"three", "four", "five"},
		},
		{
			name:     "a limit takes the newest, still oldest first",
			capacity: 4,
			written:  "one\ntwo\nthree\n",
			limit:    2,
			want:     []string{"two", "three"},
		},
		{
			name:     "a limit past what is held is what is held",
			capacity: 4,
			written:  "one\n",
			limit:    10,
			want:     []string{"one"},
		},
		{
			name:     "no limit is no lines",
			capacity: 4,
			written:  "one\ntwo\n",
			limit:    0,
			want:     []string{},
		},
		{
			name:     "nothing written is nothing to read",
			capacity: 4,
			written:  "",
			limit:    -1,
			want:     []string{},
		},
		{
			name:     "a line still being written is not a line yet",
			capacity: 4,
			written:  "one\ntwo",
			limit:    -1,
			want:     []string{"one"},
		},
		{
			name:     "a blank line the child wrote is a line",
			capacity: 4,
			written:  "one\n\ntwo\n",
			limit:    -1,
			want:     []string{"one", "", "two"},
		},
		{
			name:     "a carriage return never reaches a reader",
			capacity: 4,
			written:  "one\r\ntwo\r\n",
			limit:    -1,
			want:     []string{"one", "two"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ring := NewRing(tc.capacity)
			if _, err := ring.Write([]byte(tc.written)); err != nil {
				t.Fatalf("Write: %v", err)
			}

			got := ring.Lines(tc.limit)
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// The buffer is what keeps a crashed child's output around, so it must not grow with it.
func TestRingHoldsOnlyItsCapacity(t *testing.T) {
	ring := NewRing(8)
	for i := range 10_000 {
		fmt.Fprintf(ring, "line %d\n", i)
	}

	held := ring.Lines(-1)
	if len(held) != 8 {
		t.Fatalf("held: got %d lines, want 8", len(held))
	}
	if held[7] != "line 9999" {
		t.Errorf("newest: got %q, want the last line written", held[7])
	}
}

// A child writing without a newline cannot hold this buffer open forever.
func TestRingCutsALineThatNeverEnds(t *testing.T) {
	ring := NewRing(4)
	if _, err := ring.Write([]byte(strings.Repeat("x", maxLineLen*2))); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if held := ring.Lines(-1); len(held) != 2 {
		t.Errorf("got %d lines, want the run cut into 2", len(held))
	}
}

// What a crashing child left half-written is kept, ahead of this box's note that it ended.
func TestRingKeepsAPartialLineWhenTheChildEnds(t *testing.T) {
	ring := NewRing(4)
	if _, err := ring.Write([]byte("panicked at ")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	ring.Add("game-instance exited: signal: killed")

	held := ring.Lines(-1)
	if len(held) != 2 || held[0] != "panicked at " {
		t.Errorf("got %q, want the partial line kept first", held)
	}
}

// The ring one child writes into is the one its logs route reads back.
func TestLogsComeBackThroughTheRegistry(t *testing.T) {
	registry, launcher := newTestRegistry(1)
	view := startN(t, registry, 1)[0]

	fmt.Fprint(launcher.logsOf(0), "listening addr=0.0.0.0:30001\nboot ok\n")

	lines, err := registry.Logs(view.InstanceID, -1)
	if err != nil {
		t.Fatalf("Logs: %v", err)
	}
	if len(lines) != 2 || lines[1] != "boot ok" {
		t.Errorf("got %q", lines)
	}

	if _, err := registry.Logs("6f1e5a3c-0b2d-4c8e-9a71-000000000000", -1); err == nil {
		t.Error("an unknown instance answered with logs")
	}
}

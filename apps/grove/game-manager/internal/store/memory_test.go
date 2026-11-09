package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	gameA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	gameB = "9c858901-8a57-4791-81fe-4c455b099bc9"
)

func TestAGameHoldsOnlyAsManyKeysAsItMay(t *testing.T) {
	memory := NewMemory()
	for i := range maxGameKeys - 1 {
		write(t, memory, gameA, fmt.Sprintf("key-%d", i), `1`)
	}

	// Rewriting a key spends none of the budget, so the row a game has left is still the game's to
	// take however many times it has moved the rows it holds.
	for range 3 {
		write(t, memory, gameA, "key-0", `2`)
	}
	write(t, memory, gameA, "the-last-one", `1`)

	// A key the game already holds is a swap rather than a row, so a game at the bound can still
	// move what it has.
	if _, err := memory.Write(context.Background(), gameA, "key-0", value(`2`)); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	if _, err := memory.Write(context.Background(), gameA, "one-more", value(`1`)); !errors.Is(err, ErrTooManyKeys) {
		t.Fatalf("err: got %v, want %v", err, ErrTooManyKeys)
	}

	// Releasing a row releases the key it held, which is what makes the bound survivable.
	if err := memory.Delete(context.Background(), gameA, "key-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := memory.Write(context.Background(), gameA, "one-more", value(`1`)); err != nil {
		t.Fatalf("after the release: %v", err)
	}

	// The bound is one game's, so a neighbour on the same process keeps every key it never spent.
	if _, err := memory.Write(context.Background(), gameB, "one-more", value(`1`)); err != nil {
		t.Fatalf("neighbour: %v", err)
	}
}

func TestAGameHoldsOnlyAsManyBytesAsItMay(t *testing.T) {
	memory := NewMemory()
	// A game's whole footprint, so what follows is one byte past the budget however small it is.
	write(t, memory, gameA, "held", `"`+strings.Repeat("a", maxGameBytes-2)+`"`)

	if _, err := memory.Write(context.Background(), gameA, "one-more", value(`1`)); !errors.Is(err, ErrGameFull) {
		t.Fatalf("err: got %v, want %v", err, ErrGameFull)
	}

	// A key the game already holds is a swap rather than a fresh footprint, so a game at the bound
	// can still rewrite one smaller and spend the room that gave back.
	write(t, memory, gameA, "held", `"`+strings.Repeat("a", maxGameBytes-3)+`"`)
	write(t, memory, gameA, "after-the-swap", `1`)

	// Releasing the row releases the bytes it held, which is what makes the bound survivable.
	if err := memory.Delete(context.Background(), gameA, "held"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := memory.Write(context.Background(), gameA, "one-more", value(`1`)); err != nil {
		t.Fatalf("after the release: %v", err)
	}
}

func TestDeleteLeavesAKeyNeverWritten(t *testing.T) {
	memory := NewMemory()
	write(t, memory, gameA, "score", `{"points":1}`)
	write(t, memory, gameB, "score", `{"points":2}`)

	if err := memory.Delete(context.Background(), gameA, "score"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := memory.Read(context.Background(), gameA, "score"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read: got %v, want %v", err, ErrNotFound)
	}
	if err := memory.Delete(context.Background(), gameA, "score"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: got %v, want %v", err, ErrNotFound)
	}

	// A released key is at revision zero again, so the game's next write to it is a first write.
	revision := write(t, memory, gameA, "score", `{"points":3}`)
	if revision != 1 {
		t.Fatalf("revision: got %d, want 1", revision)
	}

	// A delete reaches a row only through the game that owns it.
	held, err := memory.Read(context.Background(), gameB, "score")
	if err != nil {
		t.Fatalf("neighbour: %v", err)
	}
	if got := string(held.Value); got != `{"points":2}` {
		t.Fatalf("neighbour value: got %s, want the row the delete never named", got)
	}
}

func TestRowsLiveOnlyInTheProcessHoldingThem(t *testing.T) {
	memory := NewMemory()
	write(t, memory, gameA, "score", `{"points":1}`)

	// A second set of maps reaches nothing the first one holds, which is what storing a fleet's game
	// data for the life of one process costs a fleet running more than one.
	restarted := NewMemory()
	if _, err := restarted.Read(context.Background(), gameA, "score"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("state: got %v, want %v", err, ErrNotFound)
	}
}

func write(t *testing.T, memory *Memory, game, key, held string) int64 {
	t.Helper()

	revision, err := memory.Write(context.Background(), game, key, value(held))
	if err != nil {
		t.Fatalf("write %s: %v", key, err)
	}
	return revision
}

func value(held string) contract.StateWrite {
	return contract.StateWrite{Value: json.RawMessage(held)}
}

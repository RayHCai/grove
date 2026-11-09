// The implementation behind the seam, and the one this service runs: one process's maps.

package store

import (
	"bytes"
	"context"
	"sync"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	// A game's state is one row per identified player and a handful beside them, so a game at this
	// many keys is minting them rather than holding players.
	maxGameKeys = 10_000
	// Every game on this process is stored in the same memory, so a game is bounded as a whole and
	// not only one write at a time.
	maxGameBytes = 32 << 20
)

// Memory keeps a fleet's game data for the life of one process.
type Memory struct {
	mu    sync.RWMutex
	state map[row]contract.StateRecord
	spent map[string]budget
}

// row is keyed by the game first, so no key reaches a row without naming the game that owns it.
type row struct {
	game string
	name string
}

// budget is carried alongside the rows rather than counted from them, so a bounded write costs no
// walk of a game's state.
type budget struct {
	keys  int
	bytes int
}

func NewMemory() *Memory {
	return &Memory{
		state: make(map[row]contract.StateRecord),
		spent: make(map[string]budget),
	}
}

// Ping always answers, since a map in this process is reachable exactly when this process is.
func (m *Memory) Ping(context.Context) error { return nil }

func (m *Memory) Read(_ context.Context, game, key string) (contract.StateRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	record, ok := m.state[row{game, key}]
	if !ok {
		return contract.StateRecord{}, ErrNotFound
	}
	return record, nil
}

// Write applies the value and answers the revision it landed on, or refuses a stale write.
func (m *Memory) Write(_ context.Context, game, key string, write contract.StateWrite) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	at := row{game, key}
	held, exists := m.state[at]
	// A key never written is at revision zero, which is what makes the first compare-and-set of a
	// key expressible (`ifRevision: 0`) instead of a special case a caller has to know about.
	current := held.Revision
	if write.IfRevision != nil && *write.IfRevision != current {
		return 0, ErrStale
	}

	spent := m.spent[game]
	if !exists && spent.keys >= maxGameKeys {
		return 0, ErrTooManyKeys
	}
	// Measured as the swap it is, so rewriting a key smaller leaves a game further from its bound
	// than it was.
	if spent.bytes-len(held.Value)+len(write.Value) > maxGameBytes {
		return 0, ErrGameFull
	}

	next := current + 1
	m.state[at] = contract.StateRecord{Key: key, Value: bytes.Clone(write.Value), Revision: next}
	if !exists {
		spent.keys++
	}
	spent.bytes += len(write.Value) - len(held.Value)
	m.spent[game] = spent
	return next, nil
}

// Delete releases a key and the budget it held, which is the only way a game's state shrinks.
func (m *Memory) Delete(_ context.Context, game, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	at := row{game, key}
	held, ok := m.state[at]
	if !ok {
		return ErrNotFound
	}

	delete(m.state, at)
	spent := m.spent[game]
	spent.keys--
	spent.bytes -= len(held.Value)
	m.spent[game] = spent
	return nil
}

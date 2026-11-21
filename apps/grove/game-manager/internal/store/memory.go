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
	// And the whole process too, since sixteen games at their own bound would otherwise spend it all.
	maxStoreBytes = 512 << 20
)

// Memory keeps a fleet's game data for the life of one process.
type Memory struct {
	mu    sync.RWMutex
	state map[row]contract.StateRecord
	spent map[string]budget
	// Bytes held across every game, keys included, and the most they may come to.
	held  int
	limit int
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
	// The newest revision any key of the game landed on, kept past a Delete: a key released and
	// written again lands past every revision it held, so no stale compare-and-set matches it.
	clock int64
}

func NewMemory() *Memory {
	return newMemory(maxStoreBytes)
}

func newMemory(limit int) *Memory {
	return &Memory{
		state: make(map[row]contract.StateRecord),
		spent: make(map[string]budget),
		limit: limit,
	}
}

// cost is what one row holds of the process's memory: its key as well as its value, or a game could
// spend the store a byte of value at a time under a quarter-kilobyte of key.
func cost(key string, value []byte) int {
	return len(key) + len(value)
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
	// A key not held is at revision zero, which is what makes the first compare-and-set of a key
	// expressible (`ifRevision: 0`) instead of a special case a caller has to know about.
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
	grows := cost(key, write.Value)
	if exists {
		grows -= cost(key, held.Value)
	}
	if spent.bytes+grows > maxGameBytes {
		return 0, ErrGameFull
	}
	if m.held+grows > m.limit {
		return 0, ErrStoreFull
	}

	next := spent.clock + 1
	m.state[at] = contract.StateRecord{Key: key, Value: bytes.Clone(write.Value), Revision: next}
	if !exists {
		spent.keys++
	}
	spent.bytes += grows
	spent.clock = next
	m.spent[game] = spent
	m.held += grows
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
	spent.bytes -= cost(key, held.Value)
	m.spent[game] = spent
	m.held -= cost(key, held.Value)
	return nil
}

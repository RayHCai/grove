// The implementation behind the seam, and the one this service runs: one process's maps.

package store

import (
	"bytes"
	"cmp"
	"context"
	"maps"
	"slices"
	"strconv"
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
	mu      sync.RWMutex
	state   map[row]contract.StateRecord
	spent   map[string]budget
	boards  map[row]map[string]contract.LeaderboardEntry
	bundles map[string]contract.BundleSet
}

// row is keyed by the game first, so no key here reaches a row without naming the game that owns it.
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
		state:   make(map[row]contract.StateRecord),
		spent:   make(map[string]budget),
		boards:  make(map[row]map[string]contract.LeaderboardEntry),
		bundles: make(map[string]contract.BundleSet),
	}
}

// A map in this process is reachable exactly when this process is.
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

// Write applies the value and answers the revision it landed on, or refuses a stale compare-and-set.
func (m *Memory) Write(_ context.Context, game, key string, write contract.StateWrite) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	at := row{game, key}
	held, exists := m.state[at]
	// A key never written is at revision zero, which is what makes the first compare-and-set of a
	// key expressible — `ifRevision: 0` — instead of a special case a caller has to know about.
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

func (m *Memory) Leaderboard(_ context.Context, game string, query contract.LeaderboardQuery) (contract.LeaderboardPage, error) {
	offset, err := decodeCursor(query.Cursor)
	if err != nil {
		return contract.LeaderboardPage{}, err
	}

	m.mu.RLock()
	board := slices.Collect(maps.Values(m.boards[row{game, query.Board}]))
	m.mu.RUnlock()

	// A cursor is minted only while it still names a row, so one past the board is one this board
	// never handed out.
	if offset > 0 && offset >= len(board) {
		return contract.LeaderboardPage{}, ErrBadCursor
	}

	// Ties break on the player so a page boundary falls in the same place on every call, which is
	// the whole of what makes a cursor mean anything.
	slices.SortFunc(board, func(a, b contract.LeaderboardEntry) int {
		if a.Score != b.Score {
			return cmp.Compare(b.Score, a.Score)
		}
		return cmp.Compare(a.PlayerID, b.PlayerID)
	})

	// An empty board serializes as `[]` rather than `null`, which is what `z.array` parses.
	page := contract.LeaderboardPage{Board: query.Board, Entries: []contract.LeaderboardEntry{}}
	for i := offset; i < len(board) && len(page.Entries) < query.Limit; i++ {
		entry := board[i]
		entry.Rank = i + 1
		page.Entries = append(page.Entries, entry)
	}

	if next := offset + len(page.Entries); next < len(board) {
		cursor := strconv.Itoa(next)
		page.NextCursor = &cursor
	}
	return page, nil
}

func (m *Memory) Bundles(_ context.Context, game string) (contract.BundleSet, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	set, ok := m.bundles[game]
	if !ok {
		return contract.BundleSet{}, ErrNotFound
	}
	return set, nil
}

// PutBundles registers the set a game's sessions load.
func (m *Memory) PutBundles(game string, set contract.BundleSet) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.bundles[game] = set
}

// PutScore records where one player stands on a board, replacing whatever they held before.
//
// Rank is not read from the entry: a rank is a position in a board rather than a property of a
// player, so it is assigned when a page is built.
func (m *Memory) PutScore(game, board string, entry contract.LeaderboardEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()

	at := row{game, board}
	if m.boards[at] == nil {
		m.boards[at] = make(map[string]contract.LeaderboardEntry)
	}
	m.boards[at][entry.PlayerID] = entry
}

// The cursor is this store's own offset into the sorted board.
func decodeCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}

	offset, err := strconv.Atoi(cursor)
	if err != nil || offset < 0 {
		return 0, ErrBadCursor
	}
	return offset, nil
}

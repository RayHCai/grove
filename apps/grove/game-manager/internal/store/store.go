// Package store is what this service asks of a datastore, and nothing more.
package store

import (
	"context"
	"errors"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

var (
	// A key never written, or a game never published. The 404 either way.
	ErrNotFound = errors.New("not found")
	// A write whose ifRevision is not where the key is. Refused, never applied.
	ErrStale = errors.New("revision moved")
	// A game already holding as many keys as it may. Refused rather than evicted from, because
	// which row a game no longer needs is the game's to say.
	ErrTooManyKeys = errors.New("game holds as many keys as it may")
	// A game already holding as many bytes as it may, so one game's writes cannot spend the room
	// every other game is stored in.
	ErrGameFull = errors.New("game holds as many bytes as it may")
	// A cursor shaped wrong, or one past the end of the board it pages. Refused rather than
	// restarted from the top, which would hand a paging caller the first page forever.
	ErrBadCursor = errors.New("cursor is not one this store minted")
)

// Store is every question this service asks its datastore.
//
// Each method that reaches a row takes the game as its first argument rather than reading one from
// a request, so a handler has no way to reach a row belonging to a game its token did not name.
type Store interface {
	// Here rather than behind a second seam, so readiness asks the datastore the handlers use.
	Ping(ctx context.Context) error
	Read(ctx context.Context, game, key string) (contract.StateRecord, error)
	Write(ctx context.Context, game, key string, write contract.StateWrite) (int64, error)
	// A key released here is a key never written: the next write to it lands on revision one.
	Delete(ctx context.Context, game, key string) error
	Leaderboard(ctx context.Context, game string, query contract.LeaderboardQuery) (contract.LeaderboardPage, error)
	Bundles(ctx context.Context, game string) (contract.BundleSet, error)
}

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
	// A cursor this store did not mint. Refused rather than restarted from the top, which would
	// hand a paging caller the first page forever.
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
	Leaderboard(ctx context.Context, game string, query contract.LeaderboardQuery) (contract.LeaderboardPage, error)
	Bundles(ctx context.Context, game string) (contract.BundleSet, error)
}

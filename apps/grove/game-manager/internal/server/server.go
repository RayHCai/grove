// Package server is the whole surface this service answers on: two open routes, and one scope
// everything else lives inside.
package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const rateLimitPerMinute = 600

type service struct {
	store store.Store
	log   *slog.Logger
}

// New builds the handler; ctx bounds the rate limiter's sweep. A route added to the scope is
// authenticated because of where it is registered, not because someone remembered to check.
func New(ctx context.Context, st store.Store, secret []byte, l *slog.Logger) http.Handler {
	s := &service{store: st, log: l}

	scope := http.NewServeMux()
	scope.HandleFunc("GET /v1/state/{key}", s.readState)
	scope.HandleFunc("PUT /v1/state/{key}", s.writeState)
	scope.HandleFunc("DELETE /v1/state/{key}", s.deleteState)
	scope.HandleFunc("GET /v1/leaderboard", s.readLeaderboard)
	scope.HandleFunc("GET /v1/bundles", s.readBundles)

	// A memory store always answers; a database-backed one does not while it is still connecting.
	return httpx.Service(scope, st.Ping, l,
		verifyGameToken(secret, l),
		// Inside the gate, and keyed on the game the token was VERIFIED to name. An address key
		// would be one bucket for the whole fleet network, and a key taken from the header ahead of
		// the check is one a caller mints per request, which is a fresh bucket per request.
		httpx.RateLimit(ctx, rateLimitPerMinute, time.Minute, gameID),
	)
}

// A 413 answers invalid_request because the contract's code set is closed, and a game past a bound
// is a write this service will not take rather than a failure on this side.
func atBound(w http.ResponseWriter, message string) {
	httpx.WriteError(w, http.StatusRequestEntityTooLarge, httpx.CodeInvalidRequest, message)
}

// fail is httpx.Fail with the ids the token named, so a failure greps by game and session.
func (s *service) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	httpx.Fail(w, r, s.log, what, err, "gameId", gameID(r), "sessionId", sessionID(r))
}

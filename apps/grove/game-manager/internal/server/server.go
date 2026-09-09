// Package server is the whole surface this service answers on: two open routes, and one scope
// everything else lives inside.
package server

import (
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

// New builds the handler: the two open routes, the authenticated /v1 scope, and the wraps around
// both.
//
// Nothing registered at this level decides who may call what — the scope adds the only check
// there is, so a route mounted outside it starts open and a route mounted inside it starts closed.
func New(st store.Store, secret []byte, l *slog.Logger) http.Handler {
	s := &service{store: st, log: l}

	// One mux, one middleware, every data route inside it. A route added here is authenticated
	// because of where it is registered, not because someone remembered to check.
	scope := http.NewServeMux()
	scope.HandleFunc("GET /v1/state/{key}", s.readState)
	scope.HandleFunc("PUT /v1/state/{key}", s.writeState)
	scope.HandleFunc("GET /v1/leaderboard", s.readLeaderboard)
	scope.HandleFunc("GET /v1/bundles", s.readBundles)
	// A wrong path under the scope answers only once the token has, so a caller without one cannot
	// map the routes from here.
	scope.HandleFunc("/v1/", httpx.NotFound)

	root := http.NewServeMux()
	// Polled by the local @grove/instance-manager before a token exists, so both sit OUTSIDE the
	// authenticated scope.
	root.HandleFunc("GET /health", httpx.Health)
	// A memory store always answers; a database-backed one does not while it is still connecting.
	root.HandleFunc("GET /ready", httpx.Ready(st.Ping, l))
	root.Handle("/v1/", httpx.Chain(scope,
		verifyGameToken(secret, l),
		// Inside the gate, and keyed on the game the token was VERIFIED to name. An address key
		// would be one bucket for the whole fleet network, and a key taken from the header ahead of
		// the check is one a caller mints per request — which is a fresh bucket per request.
		httpx.RateLimit(rateLimitPerMinute, time.Minute, gameID),
	))
	root.HandleFunc("/", httpx.NotFound)

	return httpx.Chain(root, httpx.RequestID(), httpx.Recover(l), httpx.RequestLog(l))
}

func bad(w http.ResponseWriter, message string) {
	httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, message)
}

// fail keeps what went wrong here and tells the caller only that something did.
func (s *service) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	s.log.ErrorContext(r.Context(), what, "err", err, "requestId", httpx.RequestIDFrom(r.Context()),
		"gameId", gameID(r), "sessionId", sessionID(r))
	httpx.WriteError(w, http.StatusInternalServerError, httpx.CodeInternal, "internal error")
}

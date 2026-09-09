// The one check this service has, and what it puts on a request that passes it.

package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/httpx"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

type ctxKey int

const (
	gameKey ctxKey = iota
	sessionKey
)

// verifyGameToken is middleware rather than a call in each handler because a route is then covered
// by where it is mounted, and forgetting the check is not something a new route can do.
//
// The claims go on the context and the URL carries neither id, so a request cannot name a game its
// token was not issued for — cross-game access is unrepresentable rather than merely rejected.
func verifyGameToken(secret []byte, l *slog.Logger) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthorized, "no token")
				return
			}

			claims, err := token.Verify(presented, secret, time.Now().Unix())
			if err != nil {
				l.WarnContext(r.Context(), "token refused",
					"reason", refusal(err), "requestId", httpx.RequestIDFrom(r.Context()))
				httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthorized, refusal(err))
				return
			}

			ctx := context.WithValue(r.Context(), gameKey, claims.GameID)
			ctx = context.WithValue(ctx, sessionKey, claims.SessionID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// The game this request may touch. Set by the middleware, never read from the URL.
func gameID(r *http.Request) string {
	id, _ := r.Context().Value(gameKey).(string)
	return id
}

func sessionID(r *http.Request) string {
	id, _ := r.Context().Value(sessionKey).(string)
	return id
}

// The words `verifySessionToken` reports on the TypeScript side, so both halves refuse alike.
func refusal(err error) string {
	switch {
	case errors.Is(err, token.ErrBadSignature):
		return "bad_signature"
	case errors.Is(err, token.ErrExpired):
		return "expired"
	default:
		return "malformed"
	}
}

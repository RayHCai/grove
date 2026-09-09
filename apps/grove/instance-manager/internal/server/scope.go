// The one check this agent has.

package server

import (
	"crypto/hmac"
	"log/slog"
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/httpx"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// fleetBearer admits the one caller that has business here: @grove/server-manager, holding the
// secret this box was given with it.
//
// A shared secret rather than a signed claim because there is nothing to scope — every route below
// acts on this box, and the only question is whether the caller is inside the fleet.
func fleetBearer(secret []byte, l *slog.Logger) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			// hmac.Equal rather than ==, so a wrong secret costs the same time as a right one.
			if !ok || !hmac.Equal([]byte(presented), secret) {
				l.WarnContext(r.Context(), "bearer refused",
					"path", r.URL.Path, "requestId", httpx.RequestIDFrom(r.Context()))
				httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthorized, "no fleet bearer")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

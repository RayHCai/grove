// The one credential the routes inside the fleet are behind.

package httpx

import (
	"crypto/hmac"
	"log/slog"
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/token"
)

// FleetBearer admits only a caller holding the shared fleet secret.
//
// A shared secret rather than a credential per caller: nothing outside the fleet can route to
// these services, and the only question a route has is whether its caller is inside one. It is a
// different secret from the one signing a browser's join ticket, which these services never see.
func FleetBearer(secret []byte, l *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			// Constant time, so a caller cannot learn the secret one leading byte per request.
			if !ok || !hmac.Equal([]byte(presented), secret) {
				l.WarnContext(r.Context(), "bearer refused",
					"path", r.URL.Path, "requestId", RequestIDFrom(r.Context()))
				WriteError(w, http.StatusUnauthorized, CodeUnauthorized, "fleet credential required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

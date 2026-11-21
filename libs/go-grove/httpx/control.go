// The control plane's credential on both ends: the router signs each call to a box, and the box
// holds only the public half, so no box can command another.

package httpx

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/token"
)

// ControlLifetime is how long one signed call stays good: long enough for a clock a box keeps by
// NTP, short enough that a call read off the wire is spent before it is worth replaying.
const ControlLifetime = 60 * time.Second

// MaxControlBody is the largest body a control gate reads to hash, past every route behind it.
const MaxControlBody = 64 << 10

// SignControl is a FleetClient.Authorize that signs each call for the one box hostID names.
func SignControl(key ed25519.PrivateKey, hostID string, now func() time.Time) func(method, target string, body []byte) (string, error) {
	return func(method, target string, body []byte) (string, error) {
		return token.SignControl(token.Control{
			HostID:     hostID,
			Method:     method,
			Target:     target,
			BodySHA256: digest(body),
			Aud:        token.AudInstanceManager,
			Exp:        now().Add(ControlLifetime).Unix(),
		}, key)
	}
}

// ControlGate admits a call signed by one of keys for this box, this method, this path and query,
// and these body bytes, and nothing else.
func ControlGate(l *slog.Logger, keys []ed25519.PublicKey, hostID string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, err := io.ReadAll(io.LimitReader(r.Body, MaxControlBody+1))
			if err != nil {
				BadRequest(w, "body could not be read")
				return
			}
			if len(body) > MaxControlBody {
				WriteError(w, http.StatusRequestEntityTooLarge, CodeInvalidRequest, "body too large")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))

			if why := refuseControl(r, body, keys, hostID); why != "" {
				l.WarnContext(r.Context(), "control call refused",
					"reason", why, "path", r.URL.Path, "requestId", RequestIDFrom(r.Context()))
				WriteError(w, http.StatusUnauthorized, CodeUnauthorized, "credential required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// refuseControl names why a call is not one the router signed for this box, or nothing.
func refuseControl(r *http.Request, body []byte, keys []ed25519.PublicKey, hostID string) string {
	presented, ok := token.Bearer(r)
	if !ok {
		return "no credential"
	}
	claims, err := token.VerifyControl(presented, keys, time.Now().Unix())
	switch {
	case errors.Is(err, token.ErrExpired):
		return "expired"
	case err != nil:
		return "not signed by the router"
	case claims.HostID != hostID:
		return "signed for another box"
	case claims.Method != r.Method || claims.Target != r.URL.RequestURI():
		return "signed for another route"
	case claims.BodySHA256 != digest(body):
		return "signed for another body"
	}
	return ""
}

func digest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

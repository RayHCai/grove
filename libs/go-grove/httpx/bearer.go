// The one credential the routes inside the fleet are behind, on both ends of a call.

package httpx

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
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

// StatusError is a call that was answered, with a status the caller refused.
type StatusError struct{ Status int }

func (e *StatusError) Error() string {
	return fmt.Sprintf("answered %d", e.Status)
}

// FleetClient is the calling end of FleetBearer: one service posting to another inside the fleet.
type FleetClient struct {
	Client *http.Client
	Secret []byte
}

// PostJSON posts in (nil sends no body) and decodes up to maxAnswer bytes into a non-nil out.
func (c FleetClient) PostJSON(ctx context.Context, url string, in, out any, maxAnswer int64) (string, error) {
	var body io.Reader
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return "", fmt.Errorf("encode: %w", err)
		}
		body = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return "", fmt.Errorf("build: %w", err)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+string(c.Secret))
	requestID := Forward(req)

	res, err := c.Client.Do(req)
	if err != nil {
		return requestID, err
	}
	defer res.Body.Close()

	answer, err := io.ReadAll(io.LimitReader(res.Body, maxAnswer))
	if err != nil {
		return requestID, fmt.Errorf("read the answer: %w", err)
	}
	if res.StatusCode >= http.StatusBadRequest {
		return requestID, &StatusError{Status: res.StatusCode}
	}
	if out != nil {
		if err := json.Unmarshal(answer, out); err != nil {
			return requestID, fmt.Errorf("decode the answer: %w", err)
		}
	}
	return requestID, nil
}

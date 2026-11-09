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

// SharedSecret admits a caller presenting any one of secrets, each a credential one pair of services
// holds, so a route names exactly which callers it serves and a leaked one opens nothing else.
func SharedSecret(l *slog.Logger, secrets ...[]byte) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			if !ok || !anyEqual([]byte(presented), secrets) {
				l.WarnContext(r.Context(), "bearer refused",
					"path", r.URL.Path, "requestId", RequestIDFrom(r.Context()))
				WriteError(w, http.StatusUnauthorized, CodeUnauthorized, "credential required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Every secret is compared, in constant time, so neither a byte nor which secret matched leaks.
func anyEqual(presented []byte, secrets [][]byte) bool {
	matched := false
	for _, secret := range secrets {
		if len(secret) > 0 && hmac.Equal(presented, secret) {
			matched = true
		}
	}
	return matched
}

// StatusError is a call that was answered, with a status the caller refused.
type StatusError struct{ Status int }

func (e *StatusError) Error() string {
	return fmt.Sprintf("answered %d", e.Status)
}

// FleetClient is the calling end of SharedSecret: one service posting to another inside the fleet.
type FleetClient struct {
	Client *http.Client
	Secret []byte
}

// PostJSON posts in (nil sends no body) and decodes up to maxAnswer bytes into a non-nil out.
func (c FleetClient) PostJSON(ctx context.Context, url string, in, out any, maxAnswer int64) (string, error) {
	return c.Call(ctx, http.MethodPost, url, in, out, maxAnswer)
}

// Call is PostJSON under any method, and answers the request id it went out under.
func (c FleetClient) Call(ctx context.Context, method, url string, in, out any, maxAnswer int64) (string, error) {
	var body io.Reader
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return "", fmt.Errorf("encode: %w", err)
		}
		body = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, body)
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

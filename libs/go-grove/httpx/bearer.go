// The credentials the routes inside the fleet are behind, on both ends of a call.

package httpx

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
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
	return Gate(l, SecretAdmits(secrets...))
}

// Admits is one way a caller may prove what it is, given the bearer it presented.
type Admits func(r *http.Request, presented string) bool

// Gate lets a request through when any of admits accepts its bearer, and answers 401 otherwise.
func Gate(l *slog.Logger, admits ...Admits) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			// Every check runs, so which one matched is not a timing a caller can read.
			admitted := false
			for _, admit := range admits {
				if ok && admit(r, presented) {
					admitted = true
				}
			}
			if !admitted {
				l.WarnContext(r.Context(), "bearer refused",
					"path", r.URL.Path, "requestId", RequestIDFrom(r.Context()))
				WriteError(w, http.StatusUnauthorized, CodeUnauthorized, "credential required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SecretAdmits accepts any one of secrets, compared in constant time.
func SecretAdmits(secrets ...[]byte) Admits {
	return func(_ *http.Request, presented string) bool {
		return anyEqual([]byte(presented), secrets)
	}
}

// HostKey is the bearer one box beats with: lowercase hex of HMAC-SHA256(fleetSecret, hostID). The
// receiver holds fleetSecret and derives it again, so a box holding only its own key names only itself.
func HostKey(fleetSecret []byte, hostID string) string {
	mac := hmac.New(sha256.New, fleetSecret)
	mac.Write([]byte(hostID))
	return hex.EncodeToString(mac.Sum(nil))
}

// HostKeyAdmits accepts the key of the box hostOf names, and never one derived from an empty secret.
func HostKeyAdmits(fleetSecret []byte, hostOf func(*http.Request) string) Admits {
	return func(r *http.Request, presented string) bool {
		hostID := hostOf(r)
		if len(fleetSecret) == 0 || hostID == "" {
			return false
		}
		return hmac.Equal([]byte(presented), []byte(HostKey(fleetSecret, hostID)))
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

// FleetClient is the calling end of a Gate: one service posting to another inside the fleet.
type FleetClient struct {
	Client *http.Client
	// The bearer every call carries, unless Authorize is set.
	Secret []byte
	// Mints the bearer for one call from what it is about to send, for a gate that binds the request.
	Authorize func(method, target string, body []byte) (string, error)
}

// PostJSON posts in (nil sends no body) and decodes up to maxAnswer bytes into a non-nil out.
func (c FleetClient) PostJSON(ctx context.Context, url string, in, out any, maxAnswer int64) (string, error) {
	return c.Call(ctx, http.MethodPost, url, in, out, maxAnswer)
}

// Call is PostJSON under any method, and answers the request id it went out under.
func (c FleetClient) Call(ctx context.Context, method, url string, in, out any, maxAnswer int64) (string, error) {
	var encoded []byte
	var body io.Reader
	if in != nil {
		var err error
		if encoded, err = json.Marshal(in); err != nil {
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
	bearer := string(c.Secret)
	if c.Authorize != nil {
		if bearer, err = c.Authorize(method, req.URL.RequestURI(), encoded); err != nil {
			return "", fmt.Errorf("authorize: %w", err)
		}
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
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

package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

func TestFleetClientPostsUnderTheBearerAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer s3cret" {
			t.Errorf("authorization: got %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content-type: got %q", r.Header.Get("Content-Type"))
		}
		if !contract.ValidRequestID(r.Header.Get(contract.RequestIDHeader)) {
			t.Errorf("no request id went out")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"n":1}` {
			t.Errorf("body: got %s", body)
		}
		WriteJSON(w, http.StatusOK, map[string]int{"n": 2})
	}))
	defer srv.Close()

	c := FleetClient{Client: &http.Client{Timeout: time.Second}, Secret: []byte("s3cret")}
	var out struct{ N int }
	id, err := c.PostJSON(context.Background(), srv.URL, map[string]int{"n": 1}, &out, 1024)
	if err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if out.N != 2 || id == "" {
		t.Errorf("got %+v under %q", out, id)
	}
}

func TestFleetClientSurfacesTheStatusItRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > 0 {
			t.Errorf("a nil body went out as %d bytes", r.ContentLength)
		}
		WriteError(w, http.StatusConflict, CodeConflict, "full")
	}))
	defer srv.Close()

	c := FleetClient{Client: &http.Client{Timeout: time.Second}}
	_, err := c.PostJSON(context.Background(), srv.URL, nil, nil, 1024)

	var status *StatusError
	if !errors.As(err, &status) || status.Status != http.StatusConflict {
		t.Fatalf("got %v, want a StatusError carrying 409", err)
	}
}

// Each route names the credentials it serves, so one gate admits several and refuses the rest.
func TestSharedSecretAdmitsOnlyTheSecretsItWasGiven(t *testing.T) {
	const (
		fleet  = "fleet-secret-of-at-least-32-characters"
		caller = "caller-secret-of-at-least-32-characters"
	)
	gate := SharedSecret(discardLogger(), []byte(fleet), []byte(caller))
	open := gate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for _, tt := range []struct {
		name   string
		header string
		want   int
	}{
		{"the first secret", "Bearer " + fleet, http.StatusNoContent},
		{"the second secret", "Bearer " + caller, http.StatusNoContent},
		{"a secret neither pair holds", "Bearer " + strings.Repeat("x", len(fleet)), http.StatusUnauthorized},
		{"a prefix of one", "Bearer " + fleet[:12], http.StatusUnauthorized},
		{"no credential", "", http.StatusUnauthorized},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/v1/thing", nil)
			if tt.header != "" {
				r.Header.Set("Authorization", tt.header)
			}
			w := httptest.NewRecorder()
			open.ServeHTTP(w, r)
			if w.Code != tt.want {
				t.Errorf("got %d, want %d", w.Code, tt.want)
			}
		})
	}

	// An unset secret is never a credential, or a service missing one would admit an empty match.
	none := SharedSecret(discardLogger(), nil)(open)
	r := httptest.NewRequest(http.MethodGet, "/v1/thing", nil)
	r.Header.Set("Authorization", "Bearer ")
	w := httptest.NewRecorder()
	none.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("a gate holding no secret: got %d, want 401", w.Code)
	}
}

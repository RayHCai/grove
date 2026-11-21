package httpx

import (
	"bytes"
	"crypto/ed25519"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	thisBox  = "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70"
	otherBox = "0b8e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4"
)

var routerKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, ed25519.SeedSize))

// boxGate is one box's scope, answering 204 and keeping the body it was handed.
func boxGate(seen *[]byte) http.Handler {
	keys := []ed25519.PublicKey{routerKey.Public().(ed25519.PublicKey)}
	return ControlGate(slog.New(slog.DiscardHandler), keys, thisBox)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
}

func signed(t *testing.T, hostID, method, target, body string, now func() time.Time) string {
	t.Helper()
	bearer, err := SignControl(routerKey, hostID, now)(method, target, []byte(body))
	if err != nil {
		t.Fatalf("SignControl: %v", err)
	}
	return bearer
}

// A call is good for one box, one route and one body, and only while it is fresh.
func TestAControlCallIsBoundToItsBoxRouteAndBody(t *testing.T) {
	const target = "/v1/instances/x/logs?limit=3"
	stale := func() time.Time { return time.Now().Add(-2 * ControlLifetime) }

	cases := []struct {
		name   string
		bearer string
		method string
		target string
		body   string
		want   int
	}{
		{"as signed", signed(t, thisBox, "POST", target, "{}", time.Now), "POST", target, "{}", http.StatusNoContent},
		{"for another box", signed(t, otherBox, "POST", target, "{}", time.Now), "POST", target, "{}", http.StatusUnauthorized},
		{"under another method", signed(t, thisBox, "POST", target, "{}", time.Now), "DELETE", target, "{}", http.StatusUnauthorized},
		{"onto another query", signed(t, thisBox, "POST", target, "{}", time.Now), "POST", "/v1/instances/x/logs?limit=9", "{}", http.StatusUnauthorized},
		{"with another body", signed(t, thisBox, "POST", target, "{}", time.Now), "POST", target, `{"a":1}`, http.StatusUnauthorized},
		{"past its life", signed(t, thisBox, "POST", target, "{}", stale), "POST", target, "{}", http.StatusUnauthorized},
		{"a shared secret", strings.Repeat("s", 40), "POST", target, "{}", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen []byte
			req := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
			req.Header.Set("Authorization", "Bearer "+tc.bearer)
			w := httptest.NewRecorder()
			boxGate(&seen).ServeHTTP(w, req)

			if w.Code != tc.want {
				t.Fatalf("got %d, want %d (%s)", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusNoContent && string(seen) != tc.body {
				t.Errorf("the route read %q, want the body the gate hashed", seen)
			}
		})
	}
}

// The calling end signs what it sends, over a real connection, so the two halves agree on the target.
func TestAFleetClientSignsWhatTheGateChecks(t *testing.T) {
	var seen []byte
	srv := httptest.NewServer(boxGate(&seen))
	defer srv.Close()

	client := FleetClient{Client: srv.Client(), Authorize: SignControl(routerKey, thisBox, time.Now)}
	if _, err := client.PostJSON(t.Context(), srv.URL+"/v1/games/g/redeploy?x=1", map[string]int{"revision": 3}, nil, 1024); err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if string(seen) != `{"revision":3}` {
		t.Errorf("body: got %s", seen)
	}

	other := FleetClient{Client: srv.Client(), Authorize: SignControl(routerKey, otherBox, time.Now)}
	if _, err := other.Call(t.Context(), http.MethodDelete, srv.URL+"/v1/instances/i", nil, nil, 1024); err == nil {
		t.Error("a call signed for another box was taken")
	}
}

// A box's key names that box alone, so holding one opens no other box's heartbeat.
func TestAHostKeyAdmitsOnlyTheBoxItWasDerivedFor(t *testing.T) {
	secret := []byte(strings.Repeat("f", 32))
	gate := Gate(slog.New(slog.DiscardHandler), HostKeyAdmits(secret, func(r *http.Request) string {
		return r.URL.Query().Get("host")
	}))
	h := gate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	cases := []struct {
		name   string
		host   string
		bearer string
		want   int
	}{
		{"its own key", thisBox, HostKey(secret, thisBox), http.StatusNoContent},
		{"another box's key", thisBox, HostKey(secret, otherBox), http.StatusUnauthorized},
		{"the secret itself", thisBox, string(secret), http.StatusUnauthorized},
		{"a key for no box", "", HostKey(secret, ""), http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/beat?host="+tc.host, nil)
			req.Header.Set("Authorization", "Bearer "+tc.bearer)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d", w.Code, tc.want)
			}
		})
	}
}

// Pinned to a digest Python and OpenSSL both compute, since a box is provisioned its key outside Go.
func TestAHostKeyIsTheHexOfTheHMAC(t *testing.T) {
	const want = "0e0decfe31da9e310ad9b8bd5cc616838f0d6732d56faa0e34aa5b970d9b71f3"
	if got := HostKey([]byte("dev-fleet-secret-not-for-anything-real!"), thisBox); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

package fleet

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const agentSecret = "a-fleet-secret-of-at-least-32-chars"

// The key every call to a box in this file is signed with.
var controlKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))

// box is one agent over real TLS, recording what it was asked and answering as told.
type box struct {
	mu    sync.Mutex
	calls []string
	body  []byte
	reply func(w http.ResponseWriter, r *http.Request)
}

func (b *box) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	b.mu.Lock()
	b.calls = append(b.calls, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
	b.body = body
	reply := b.reply
	b.mu.Unlock()
	reply(w, r)
}

func (b *box) asked() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.calls...)
}

// dialled is the agent at srv as a beat would have described it: by name, on its port, under TLS.
func dialled(t *testing.T, srv *httptest.Server) (HTTPAgent, Host) {
	t.Helper()

	_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	agentPort, _ := strconv.Atoi(port)
	agent := HTTPAgent{Client: srv.Client(), ControlKey: controlKey, Secret: []byte(agentSecret), Now: time.Now}
	return agent, Host{ID: hostA, PublicHost: "127.0.0.1", Addr: "192.0.2.99", AgentPort: agentPort, TLS: true}
}

// gated is b behind the gate a box mounts for hostID, so a call that reaches b is one that box takes.
func gated(b http.Handler, hostID string) http.Handler {
	keys := []ed25519.PublicKey{controlKey.Public().(ed25519.PublicKey)}
	return httpx.ControlGate(slog.New(slog.DiscardHandler), keys, hostID)(b)
}

func TestHTTPAgentStartsAWorldOverTLS(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, r *http.Request) {
		var req contract.InstanceStart
		_ = json.NewDecoder(r.Body).Decode(&req)
		httpx.WriteJSON(w, http.StatusCreated, contract.InstanceReport{
			InstanceID: "9c858901-8a57-4791-81fe-4c455b099bc9", SessionID: "s", State: contract.InstanceStarting,
			Revision: 7, Port: gamePort,
		})
	}}
	srv := httptest.NewTLSServer(gated(b, hostA))
	defer srv.Close()
	agent, host := dialled(t, srv)

	started, err := agent.Start(context.Background(), host, contract.InstanceStart{SessionID: "s", StoreToken: "bearer"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Port != gamePort {
		t.Errorf("port: got %d", started.Port)
	}
	// The box's public name rather than the beat's source address, signed for that box, and never
	// carrying the fleet secret.
	if call := b.asked()[0]; !strings.HasPrefix(call, "POST /v1/instances Bearer ") || strings.Contains(call, agentSecret) {
		t.Errorf("call: got %q, want a signed start", call)
	}
}

// A call signed for one box is refused by every other, so a box that read one can command no other.
func TestHTTPAgentSignsEachCallForTheBoxItDials(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }}
	srv := httptest.NewTLSServer(gated(b, hostB))
	defer srv.Close()
	agent, host := dialled(t, srv)

	err := agent.Stop(context.Background(), host, "9c858901-8a57-4791-81fe-4c455b099bc9")
	var status *httpx.StatusError
	if !errors.As(err, &status) || status.Status != http.StatusUnauthorized {
		t.Fatalf("a call signed for %s at %s: got %v, want 401", hostA, hostB, err)
	}
	if calls := b.asked(); len(calls) != 0 {
		t.Errorf("the box ran %v", calls)
	}
}

// A box that still beats under the fleet secret predates the gate, and is called under that secret.
func TestHTTPAgentPresentsTheSecretOnlyToABoxThatBeatUnderIt(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }}
	srv := httptest.NewTLSServer(b)
	defer srv.Close()
	agent, host := dialled(t, srv)
	host.SharedSecret = true

	if err := agent.Stop(context.Background(), host, "9c858901-8a57-4791-81fe-4c455b099bc9"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if want := "DELETE /v1/instances/9c858901-8a57-4791-81fe-4c455b099bc9 Bearer " + agentSecret; b.asked()[0] != want {
		t.Errorf("call: got %q, want %q", b.asked()[0], want)
	}
}

func TestHTTPAgentReadsAFullBoxApartFromAFailingOne(t *testing.T) {
	for _, tc := range []struct {
		status int
		full   bool
	}{{http.StatusConflict, true}, {http.StatusInternalServerError, false}, {http.StatusNotFound, false}} {
		t.Run(strconv.Itoa(tc.status), func(t *testing.T) {
			srv := httptest.NewTLSServer(gated(&box{reply: func(w http.ResponseWriter, _ *http.Request) {
				httpx.WriteError(w, tc.status, httpx.CodeConflict, "no")
			}}, hostA))
			defer srv.Close()
			agent, host := dialled(t, srv)

			_, err := agent.Start(context.Background(), host, contract.InstanceStart{})
			if errors.Is(err, ErrHostFull) != tc.full || err == nil {
				t.Errorf("got %v, want ErrHostFull %t", err, tc.full)
			}
		})
	}
}

func TestHTTPAgentRedeploysCarryingTheRevisionAndItsCode(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, contract.HostDeployment{
			HostID: "someone-else", InstanceIDs: []string{"w1"}, Status: contract.DeployDraining,
		})
	}}
	srv := httptest.NewTLSServer(gated(b, hostA))
	defer srv.Close()
	agent, host := dialled(t, srv)

	code := contract.BundleSet{SyncedHash: strings.Repeat("a", 64)}
	row := agent.Redeploy(context.Background(), host, gameID, 8, code)
	if row.HostID != hostA || row.Status != contract.DeployDraining || len(row.InstanceIDs) != 1 {
		t.Errorf("row: got %+v, want the dialled box draining its one world", row)
	}
	var push contract.RedeployRequest
	if err := json.Unmarshal(b.body, &push); err != nil || push.Revision != 8 || push.Bundles == nil ||
		push.Bundles.SyncedHash != code.SyncedHash {
		t.Errorf("body: got %s, want the pushed revision and its code", b.body)
	}

	srv.Close()
	if failed := agent.Redeploy(context.Background(), host, gameID, 8, code); failed.Status != contract.DeployFailed || failed.Error == "" {
		t.Errorf("an unreachable box: got %+v, want a failed row saying why", failed)
	}
}

func TestHTTPAgentStopsAWorld(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }}
	srv := httptest.NewTLSServer(gated(b, hostA))
	defer srv.Close()
	agent, host := dialled(t, srv)

	if err := agent.Stop(context.Background(), host, "9c858901-8a57-4791-81fe-4c455b099bc9"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if call := b.asked()[0]; !strings.HasPrefix(call, "DELETE /v1/instances/9c858901-8a57-4791-81fe-4c455b099bc9 Bearer ") {
		t.Errorf("call: got %q", call)
	}
}

// A stop waits out the box's drain, which outlasts the backstop every other call to a box is held
// to; the caller's own context is its bound.
func TestHTTPAgentStopOutlastsTheClientBackstop(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}}
	srv := httptest.NewTLSServer(gated(b, hostA))
	defer srv.Close()
	agent, host := dialled(t, srv)
	backstopped := *srv.Client()
	backstopped.Timeout = 50 * time.Millisecond
	agent.Client = &backstopped

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := agent.Stop(ctx, host, "9c858901-8a57-4791-81fe-4c455b099bc9"); err != nil {
		t.Fatalf("Stop: %v, want the drain waited for under the caller's own deadline", err)
	}
}

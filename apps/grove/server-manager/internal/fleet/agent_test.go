package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const agentSecret = "a-fleet-secret-of-at-least-32-chars"

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

// dialled is the agent at srv as a beat would have described it: by name, on its port, under TLS.
func dialled(t *testing.T, srv *httptest.Server) (HTTPAgent, Host) {
	t.Helper()

	_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	agentPort, _ := strconv.Atoi(port)
	agent := HTTPAgent{Client: srv.Client(), Secret: []byte(agentSecret)}
	return agent, Host{ID: hostA, PublicHost: "127.0.0.1", Addr: "192.0.2.99", AgentPort: agentPort, TLS: true}
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
	srv := httptest.NewTLSServer(b)
	defer srv.Close()
	agent, host := dialled(t, srv)

	started, err := agent.Start(context.Background(), host, contract.InstanceStart{SessionID: "s", StoreToken: "bearer"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Port != gamePort {
		t.Errorf("port: got %d", started.Port)
	}
	// The box's public name rather than the beat's source address, and the fleet bearer with it.
	if want := "POST /v1/instances Bearer " + agentSecret; b.calls[0] != want {
		t.Errorf("call: got %q, want %q", b.calls[0], want)
	}
}

func TestHTTPAgentReadsAFullBoxApartFromAFailingOne(t *testing.T) {
	for _, tc := range []struct {
		status int
		full   bool
	}{{http.StatusConflict, true}, {http.StatusInternalServerError, false}, {http.StatusNotFound, false}} {
		t.Run(strconv.Itoa(tc.status), func(t *testing.T) {
			srv := httptest.NewTLSServer(&box{reply: func(w http.ResponseWriter, _ *http.Request) {
				httpx.WriteError(w, tc.status, httpx.CodeConflict, "no")
			}})
			defer srv.Close()
			agent, host := dialled(t, srv)

			_, err := agent.Start(context.Background(), host, contract.InstanceStart{})
			if errors.Is(err, ErrHostFull) != tc.full || err == nil {
				t.Errorf("got %v, want ErrHostFull %t", err, tc.full)
			}
		})
	}
}

func TestHTTPAgentRedeploysCarryingTheRevision(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, contract.HostDeployment{
			HostID: "someone-else", InstanceIDs: []string{"w1"}, Status: contract.DeployDraining,
		})
	}}
	srv := httptest.NewTLSServer(b)
	defer srv.Close()
	agent, host := dialled(t, srv)

	row := agent.Redeploy(context.Background(), host, gameID, 8)
	if row.HostID != hostA || row.Status != contract.DeployDraining || len(row.InstanceIDs) != 1 {
		t.Errorf("row: got %+v, want the dialled box draining its one world", row)
	}
	if string(b.body) != `{"revision":8}` {
		t.Errorf("body: got %s, want the pushed revision", b.body)
	}

	srv.Close()
	if failed := agent.Redeploy(context.Background(), host, gameID, 8); failed.Status != contract.DeployFailed || failed.Error == "" {
		t.Errorf("an unreachable box: got %+v, want a failed row saying why", failed)
	}
}

func TestHTTPAgentStopsAWorld(t *testing.T) {
	b := &box{reply: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }}
	srv := httptest.NewTLSServer(b)
	defer srv.Close()
	agent, host := dialled(t, srv)

	if err := agent.Stop(context.Background(), host, "9c858901-8a57-4791-81fe-4c455b099bc9"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if want := "DELETE /v1/instances/9c858901-8a57-4791-81fe-4c455b099bc9 Bearer " + agentSecret; b.calls[0] != want {
		t.Errorf("call: got %q, want %q", b.calls[0], want)
	}
}

package supervisor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// The probe is the only thing on this box that talks to a game process, so a poll that carries no
// id leaves the child's account of why it went quiet under a name nothing here ever wrote down.
func TestProbeNamesTheChildTheIDItWillLogUnder(t *testing.T) {
	var presented string
	child := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented = r.Header.Get(contract.RequestIDHeader)
		_, _ = w.Write([]byte(`{"players":3}`))
	}))
	defer child.Close()

	vitals, requestID, err := NewHTTPProber(time.Second).Probe(context.Background(), addrOf(child.URL))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if vitals.Players != 3 {
		t.Fatalf("players = %d, want 3", vitals.Players)
	}
	if !contract.ValidRequestID(presented) {
		t.Fatalf("the child was sent %q, which is not one token it can log", presented)
	}
	if presented != requestID {
		t.Fatalf("the child saw %q and the agent reported %q", presented, requestID)
	}
}

// A failed poll is the one an operator traces, so it has to report the id as well as the error.
func TestARefusedProbeStillReportsTheIDItAskedUnder(t *testing.T) {
	child := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer child.Close()

	_, requestID, err := NewHTTPProber(time.Second).Probe(context.Background(), addrOf(child.URL))
	if err == nil {
		t.Fatal("a 503 from a child is a failed probe")
	}
	if !contract.ValidRequestID(requestID) {
		t.Fatalf("requestID = %q, which names nothing", requestID)
	}
}

// The prober dials a host:port, and httptest hands back a URL.
func addrOf(url string) string {
	return url[len("http://"):]
}

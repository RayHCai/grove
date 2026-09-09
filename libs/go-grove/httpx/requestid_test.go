package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Runs one request through RequestID and reports the id the handler beneath it saw.
func idReaching(t *testing.T, r *http.Request) (string, *httptest.ResponseRecorder) {
	t.Helper()

	var seen string
	w := httptest.NewRecorder()
	RequestID()(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = RequestIDFrom(r.Context())
	})).ServeHTTP(w, r)

	return seen, w
}

func TestRequestIDKeepsOneItCanLog(t *testing.T) {
	r := httptest.NewRequest("GET", "/v1/hosts", nil)
	r.Header.Set(contract.RequestIDHeader, "9f8c2b1a-0000-4000-8000-00000000abcd")

	seen, w := idReaching(t, r)

	if seen != "9f8c2b1a-0000-4000-8000-00000000abcd" {
		t.Errorf("the caller's id must reach the handler, got %q", seen)
	}
	if got := w.Header().Get(contract.RequestIDHeader); got != seen {
		t.Errorf("echo: got %q, want %q", got, seen)
	}
}

func TestRequestIDMintsWhenThereIsNone(t *testing.T) {
	seen, w := idReaching(t, httptest.NewRequest("GET", "/v1/hosts", nil))

	if !contract.ValidUUID(seen) {
		t.Errorf("a minted id must be a uuid, got %q", seen)
	}
	if got := w.Header().Get(contract.RequestIDHeader); got != seen {
		t.Errorf("echo: got %q, want the minted %q", got, seen)
	}
}

// A recorder keeps a header set after WriteHeader and a socket does not, so only a real connection
// holds the echo to being set before the handler beneath it writes a status.
func TestRequestIDEchoesOverARealConnection(t *testing.T) {
	const sent = "9f8c2b1a-0000-4000-8000-00000000abcd"

	srv := httptest.NewServer(RequestID()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})))
	defer srv.Close()

	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, srv.URL+"/v1/hosts", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(contract.RequestIDHeader, sent)

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	if resp.StatusCode != http.StatusCreated {
		t.Errorf("status: got %d", resp.StatusCode)
	}
	if string(body) != `{"ok":true}` {
		t.Errorf("body: got %s", body)
	}
	if got := resp.Header.Get(contract.RequestIDHeader); got != sent {
		t.Errorf("echo over the wire: got %q, want %q", got, sent)
	}
}

// A caller does not get to choose what a log line costs, or how many tokens one id greps as.
func TestRequestIDReplacesOneItCannotLog(t *testing.T) {
	for _, tc := range []struct {
		name string
		sent string
	}{
		{"too long", strings.Repeat("a", contract.RequestIDMaxLen+1)},
		{"a space", "two words"},
		{"a newline", "first\nsecond"},
		{"not ascii", "id-\xff-here"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/v1/hosts", nil)
			r.Header.Set(contract.RequestIDHeader, tc.sent)

			seen, _ := idReaching(t, r)

			if seen == tc.sent {
				t.Errorf("%q must not be carried through", tc.sent)
			}
			if !contract.ValidUUID(seen) {
				t.Errorf("the replacement must be a uuid, got %q", seen)
			}
		})
	}
}

// Outside the middleware there is no id, and every reader has to survive that rather than panic.
func TestRequestIDFromIsEmptyWithoutTheMiddleware(t *testing.T) {
	if got := RequestIDFrom(context.Background()); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// One line per request is only a correlation key if the id is on it.
func TestRequestLogCarriesTheID(t *testing.T) {
	var logged bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logged, nil))

	r := httptest.NewRequest("GET", "/v1/hosts", nil)
	r.Header.Set(contract.RequestIDHeader, "known-id")

	Chain(http.HandlerFunc(Health), RequestID(), RequestLog(log)).
		ServeHTTP(httptest.NewRecorder(), r)

	var line map[string]any
	if err := json.Unmarshal(logged.Bytes(), &line); err != nil {
		t.Fatalf("the log line is not json: %v\n%s", err, logged.String())
	}
	if line["requestId"] != "known-id" {
		t.Errorf("requestId: got %v", line["requestId"])
	}
}

// The panic line is the one a reader reaches for, so it is the one that most needs the id.
func TestRecoverCarriesTheID(t *testing.T) {
	var logged bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logged, nil))

	r := httptest.NewRequest("GET", "/v1/hosts", nil)
	r.Header.Set(contract.RequestIDHeader, "known-id")

	Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("the store is nil") }),
		RequestID(), Recover(log)).ServeHTTP(httptest.NewRecorder(), r)

	var line map[string]any
	if err := json.Unmarshal(logged.Bytes(), &line); err != nil {
		t.Fatalf("the log line is not json: %v\n%s", err, logged.String())
	}
	if line["requestId"] != "known-id" {
		t.Errorf("requestId: got %v", line["requestId"])
	}
}

func TestForwardCarriesTheIDOutbound(t *testing.T) {
	inbound := httptest.NewRequest("GET", "/v1/hosts", nil)
	inbound.Header.Set(contract.RequestIDHeader, "known-id")

	var forwarded string
	RequestID()(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		out, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "http://box/v1/instances", nil)
		if err != nil {
			t.Fatalf("build outbound: %v", err)
		}
		forwarded = Forward(out)

		if got := out.Header.Get(contract.RequestIDHeader); got != "known-id" {
			t.Errorf("outbound header: got %q", got)
		}
	})).ServeHTTP(httptest.NewRecorder(), inbound)

	if forwarded != "known-id" {
		t.Errorf("Forward reports the id it sent, got %q", forwarded)
	}
}

// A beat is nobody's request, and a beat that failed is still one line somebody has to find.
func TestForwardMintsForACallWithNothingBehindIt(t *testing.T) {
	out, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "http://manager/v1/hosts/x/heartbeat", nil)
	if err != nil {
		t.Fatalf("build outbound: %v", err)
	}

	id := Forward(out)

	if !contract.ValidUUID(id) {
		t.Errorf("got %q, want a minted uuid", id)
	}
	if got := out.Header.Get(contract.RequestIDHeader); got != id {
		t.Errorf("header: got %q, want %q", got, id)
	}
}

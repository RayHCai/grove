package proxy

import (
	"bufio"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const world = "9c858901-8a57-4791-81fe-4c455b099bc9"

type worlds map[string]int

func (w worlds) Port(id string) (int, bool) {
	port, ok := w[id]
	return port, ok
}

// child is a game process as the proxy reaches it: it takes an upgrade on /play and echoes.
type child struct {
	mu   sync.Mutex
	seen *http.Request
}

func (c *child) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.seen = r.Clone(r.Context())
	c.mu.Unlock()

	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Protocol: " + r.Header.Get("Sec-WebSocket-Protocol") + "\r\n\r\n")
	_ = brw.Flush()
	_, _ = io.Copy(conn, brw)
}

func (c *child) request() *http.Request {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seen
}

// public is the player listener, with a write deadline far shorter than any game, so a tunnel that
// kept the request's deadlines would die inside the test.
func public(t *testing.T, ports worlds) *httptest.Server {
	t.Helper()

	srv := httptest.NewUnstartedServer(New(ports, slog.New(slog.DiscardHandler)))
	srv.Config.ReadTimeout = 200 * time.Millisecond
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

func portOf(t *testing.T, raw string) int {
	t.Helper()

	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %s: %v", raw, err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("port of %s: %v", raw, err)
	}
	return port
}

func TestAPlayerReachesTheWorldTheyWerePlacedIn(t *testing.T) {
	game := &child{}
	backend := httptest.NewServer(game)
	defer backend.Close()
	srv := public(t, worlds{world: portOf(t, backend.URL)})

	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /play/"+world+"?v=1 HTTP/1.1\r\nHost: box\r\n"+
		"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: grove.ticket.eyJnYW1lSWQiOiJnIn0.c2ln\r\n\r\n")

	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read the upgrade: %v", err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status: got %d, want 101", res.StatusCode)
	}
	if got := res.Header.Get("Sec-WebSocket-Protocol"); got != "grove.ticket.eyJnYW1lSWQiOiJnIn0.c2ln" {
		t.Errorf("subprotocol back: got %q", got)
	}

	seen := game.request()
	if seen.URL.Path != "/play" || seen.URL.Query().Get("v") != "1" {
		t.Errorf("the child saw %s, want /play with the query as sent", seen.URL)
	}
	if seen.Header.Get("Sec-WebSocket-Protocol") != "grove.ticket.eyJnYW1lSWQiOiJnIn0.c2ln" {
		t.Errorf("subprotocol forwarded: got %q", seen.Header.Get("Sec-WebSocket-Protocol"))
	}
	if seen.Header.Get("X-Forwarded-For") == "" {
		t.Error("the child was not told who the player is")
	}

	// Past both listener deadlines, which an upgraded socket must not inherit.
	time.Sleep(400 * time.Millisecond)
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(conn, "frame"); err != nil {
		t.Fatalf("write through the tunnel: %v", err)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(reader, echo); err != nil || string(echo) != "frame" {
		t.Fatalf("echo through the tunnel: got %q, %v", echo, err)
	}
}

func TestOnlyALiveWorldIsReachable(t *testing.T) {
	srv := public(t, worlds{world: 1})

	for _, path := range []string{
		"/play/6f1e5a3c-0b2d-4c8e-9a71-000000000000",
		"/play/not-a-world",
		"/healthz",
		"/v1/instances",
	} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, res.StatusCode)
		}
	}
}

// A ticket is single-use, so an upgrade the child dropped without answering is never sent again.
func TestAnUpgradeTheChildDroppedIsNeverRetried(t *testing.T) {
	var asked atomic.Int32
	dropping := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		asked.Add(1)
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	defer dropping.Close()

	srv := public(t, worlds{world: portOf(t, dropping.URL)})
	for range 3 {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/play/"+world+"", nil)
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadGateway {
			t.Errorf("got %d, want 502", res.StatusCode)
		}
	}
	if got := asked.Load(); got != 3 {
		t.Errorf("the child was asked %d times for 3 upgrades, want each exactly once", got)
	}
}

// A world whose child has not bound its port yet is a bad gateway, not a world that does not exist.
func TestAWorldWhoseChildIsNotListeningIsABadGateway(t *testing.T) {
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := closed.Addr().(*net.TCPAddr).Port
	closed.Close()

	res, err := http.Get(public(t, worlds{world: port}).URL + "/play/" + world)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Errorf("got %d, want 502", res.StatusCode)
	}
}

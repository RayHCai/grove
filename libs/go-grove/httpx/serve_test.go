package httpx

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHealth(t *testing.T) {
	w := httptest.NewRecorder()
	Health(w, httptest.NewRequest("GET", "/health", nil))

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d", w.Code)
	}
	if got := w.Body.String(); got != `{"ok":true}` {
		t.Errorf("body: got %s", got)
	}
}

// Serve logs from its own goroutine, so the test reads the address through a lock.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

var loggedAddr = regexp.MustCompile(`"addr":"([^"]+)"`)

// Starts Serve on a port the kernel picks and reports the address it actually bound.
func serveForTest(t *testing.T, h http.Handler) (addr string, cancel func(), done <-chan error) {
	t.Helper()

	var logged syncBuffer
	ctx, stop := context.WithCancel(context.Background())
	exited := make(chan error, 1)

	go func() {
		exited <- Serve(ctx, "127.0.0.1:0", h, slog.New(slog.NewJSONHandler(&logged, nil)))
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if match := loggedAddr.FindStringSubmatch(logged.String()); match != nil {
			return match[1], stop, exited
		}
		if time.Now().After(deadline) {
			stop()
			t.Fatalf("Serve never logged an address:\n%s", logged.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestServe(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", Health)

	addr, cancel, done := serveForTest(t, mux)

	res, err := http.Get("http://" + addr + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()

	if res.StatusCode != http.StatusOK || string(body) != `{"ok":true}` {
		t.Errorf("got %d %s", res.StatusCode, body)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("a cancelled Serve returns nil, got %v", err)
	}
}

// The drain is what makes a rolling deploy invisible: a request already inside a handler finishes.
func TestServeDrainsWhatIsInFlight(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		WriteJSON(w, http.StatusOK, map[string]bool{"finished": true})
	})

	addr, cancel, done := serveForTest(t, mux)

	type result struct {
		body string
		err  error
	}
	answered := make(chan result, 1)

	go func() {
		res, err := http.Get("http://" + addr + "/slow")
		if err != nil {
			answered <- result{err: err}
			return
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		answered <- result{body: string(body), err: err}
	}()

	<-entered
	cancel()

	// Only now does the handler finish, so it was still in flight when the shutdown began.
	close(release)

	got := <-answered
	if got.err != nil {
		t.Fatalf("the in-flight request was cut off: %v", got.err)
	}
	if got.body != `{"finished":true}` {
		t.Errorf("body: got %s", got.body)
	}
	if err := <-done; err != nil {
		t.Errorf("Serve: %v", err)
	}
}

func TestServeRefusesAPortItCannotBind(t *testing.T) {
	err := Serve(context.Background(), "127.0.0.1:99999", http.HandlerFunc(Health), discardLogger())
	if err == nil {
		t.Fatal("want an error, got nil")
	}
	if !strings.Contains(err.Error(), "listen on 127.0.0.1:99999") {
		t.Errorf("the error must name the address it failed on, got %v", err)
	}
}

// A context already cancelled means the process is going down before it ever served anything.
func TestServeReturnsOnAnAlreadyCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := Serve(ctx, "127.0.0.1:0", http.HandlerFunc(Health), discardLogger()); err != nil {
		t.Errorf("got %v, want nil", err)
	}
}

func TestReadyAnswersOkWhenTheProbeDoes(t *testing.T) {
	w := httptest.NewRecorder()
	Ready(func(context.Context) error { return nil }, discardLogger())(
		w, httptest.NewRequest("GET", "/ready", nil))

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d", w.Code)
	}
	if got := w.Body.String(); got != `{"ok":true}` {
		t.Errorf("body: got %s", got)
	}
}

// The reason is scrubbed with every other 5xx: the log keeps it, the caller gets the status.
func TestReadyAnswers503WithTheSharedErrorBody(t *testing.T) {
	w := httptest.NewRecorder()
	Ready(func(context.Context) error { return errors.New("store unreachable") }, discardLogger())(
		w, httptest.NewRequest("GET", "/ready", nil))

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d", w.Code)
	}
	if got := w.Body.String(); got != `{"code":"internal","message":"internal error"}` {
		t.Errorf("body: got %s", got)
	}
}

// A probe with no end of its own must not become one more way this route hangs.
func TestReadyBoundsAProbeThatHangs(t *testing.T) {
	w := httptest.NewRecorder()
	Ready(func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}, discardLogger())(w, httptest.NewRequest("GET", "/ready", nil))

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d", w.Code)
	}
}

// A deadline the listener does not actually carry bounds nothing, and every one of these is
// invisible at runtime until the day it is needed.
func TestTheListenerCarriesItsDeadlines(t *testing.T) {
	srv := newServer(http.HandlerFunc(Health), discardLogger())

	for _, tc := range []struct {
		name string
		got  time.Duration
		want time.Duration
	}{
		{"ReadHeaderTimeout", srv.ReadHeaderTimeout, readHeaderTimeout},
		{"ReadTimeout", srv.ReadTimeout, readTimeout},
		{"WriteTimeout", srv.WriteTimeout, writeTimeout},
		{"IdleTimeout", srv.IdleTimeout, idleTimeout},
	} {
		if tc.got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, tc.got, tc.want)
		}
	}
	if srv.MaxHeaderBytes != maxHeaderBytes {
		t.Errorf("MaxHeaderBytes: got %d, want %d", srv.MaxHeaderBytes, maxHeaderBytes)
	}
	// A listener that logged its own errors to stderr would bypass the handler every other line goes
	// to.
	if srv.ErrorLog == nil {
		t.Error("ErrorLog: got nil, want the slog bridge")
	}
}

// The four deadlines are one setting, and each is wrong on its own: a write bound under the header
// bound cuts off a response nobody was slow to ask for, and an idle bound under the ninety seconds
// a Go client holds a connection makes every caller race a close it cannot see coming.
func TestTheListenerDeadlinesHoldTogether(t *testing.T) {
	if writeTimeout <= readHeaderTimeout {
		t.Errorf("writeTimeout %s must exceed readHeaderTimeout %s", writeTimeout, readHeaderTimeout)
	}
	if readTimeout < readHeaderTimeout {
		t.Errorf("readTimeout %s must not be under readHeaderTimeout %s", readTimeout, readHeaderTimeout)
	}
	if idleTimeout <= 90*time.Second {
		t.Errorf("idleTimeout %s must exceed the 90s a Go client keeps a connection", idleTimeout)
	}
	if drainTimeout < writeTimeout {
		t.Errorf("drainTimeout %s must cover writeTimeout %s, or a restart cuts off a request that was still allowed to run", drainTimeout, writeTimeout)
	}
	if readyTimeout >= readTimeout {
		t.Errorf("readyTimeout %s must be well under readTimeout %s", readyTimeout, readTimeout)
	}
}

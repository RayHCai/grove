package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestChainAppliesTheFirstOutermost(t *testing.T) {
	var order []string

	mark := func(name string) Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}

	h := Chain(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { order = append(order, "handler") }),
		mark("outer"), mark("middle"),
	)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))

	want := []string{"outer", "middle", "handler"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("got %v, want %v", order, want)
	}
}

func TestChainWithNoMiddlewareIsTheHandler(t *testing.T) {
	w := httptest.NewRecorder()
	Chain(http.HandlerFunc(Health)).ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))

	if w.Code != http.StatusOK {
		t.Errorf("status: got %d", w.Code)
	}
}

func TestRecoverAnswers500(t *testing.T) {
	h := Recover(discardLogger())(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("the store is nil")
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/state/world", nil))

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", w.Code)
	}

	var body ErrorBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if body.Code != CodeInternal || body.Message != "internal error" {
		t.Errorf("got %+v", body)
	}
	// What panicked stays in the log; the caller learns only that it was this end's fault.
	if strings.Contains(w.Body.String(), "the store is nil") {
		t.Errorf("the panic reached the caller: %s", w.Body.String())
	}
}

func TestRecoverLogsThePanic(t *testing.T) {
	var logged bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	h := Recover(l)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("the store is nil")
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/state/world", nil))

	for _, want := range []string{"panic", "the store is nil", "/v1/state/world", "stack"} {
		if !strings.Contains(logged.String(), want) {
			t.Errorf("%q is missing from the log line:\n%s", want, logged.String())
		}
	}
}

// A status already went out, so the only honest ending is a dead connection: returning normally
// would frame a truncated body as a complete one.
func TestRecoverAbortsOnceAStatusIsOut(t *testing.T) {
	h := Recover(discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
		panic("halfway through the body")
	}))

	defer func() {
		if raised := recover(); raised != http.ErrAbortHandler {
			t.Errorf("got %v, want http.ErrAbortHandler", raised)
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	t.Error("want a re-panic, got a normal return")
}

// net/http swallows this one on purpose — it is a deliberate abort, not a fault to answer.
func TestRecoverPassesAbortHandlerThrough(t *testing.T) {
	h := Recover(discardLogger())(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	defer func() {
		if raised := recover(); raised != http.ErrAbortHandler {
			t.Errorf("got %v, want http.ErrAbortHandler", raised)
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	t.Error("want a re-panic, got a normal return")
}

func TestRequestLog(t *testing.T) {
	var logged bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	h := RequestLog(l)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusCreated, map[string]bool{"ok": true})
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/state/world", nil))

	var line map[string]any
	if err := json.Unmarshal(logged.Bytes(), &line); err != nil {
		t.Fatalf("the log line is not json: %v", err)
	}
	if line["msg"] != "request" || line["method"] != "POST" || line["path"] != "/v1/state/world" {
		t.Errorf("got %v", line)
	}
	if line["status"] != float64(http.StatusCreated) {
		t.Errorf("status: got %v", line["status"])
	}
	if line["bytes"] != float64(len(`{"ok":true}`)) {
		t.Errorf("bytes: got %v", line["bytes"])
	}
	if line["level"] != "INFO" {
		t.Errorf("level: got %v", line["level"])
	}
}

// A ticket and a cursor both live in the query, and neither belongs in a log a whole team reads.
func TestRequestLogDropsTheQuery(t *testing.T) {
	var logged bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	h := RequestLog(l)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/leaderboards?cursor=secret-cursor", nil))

	if strings.Contains(logged.String(), "secret-cursor") {
		t.Errorf("the query reached the log:\n%s", logged.String())
	}
}

// A handler that wrote nothing still sent the 200 net/http wrote for it.
func TestRequestLogRecordsTheImplicit200(t *testing.T) {
	var logged bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	h := RequestLog(l)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))

	if !strings.Contains(logged.String(), `"status":200`) {
		t.Errorf("got:\n%s", logged.String())
	}
}

func TestRequestLogRaisesTheLevelOnA500(t *testing.T) {
	var logged bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	h := RequestLog(l)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "boom")
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))

	if !strings.Contains(logged.String(), `"level":"ERROR"`) {
		t.Errorf("got:\n%s", logged.String())
	}
}

func TestRateLimit(t *testing.T) {
	byHeader := func(r *http.Request) string { return r.Header.Get("X-Caller") }
	h := RateLimit(2, time.Minute, byHeader)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	call := func(caller string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("X-Caller", caller)
		h.ServeHTTP(w, r)
		return w
	}

	if got := call("a").Code; got != http.StatusOK {
		t.Errorf("first call: got %d", got)
	}
	if got := call("a").Code; got != http.StatusOK {
		t.Errorf("second call: got %d", got)
	}

	third := call("a")
	if third.Code != http.StatusTooManyRequests {
		t.Fatalf("third call: got %d, want 429", third.Code)
	}
	if got := third.Header().Get("Retry-After"); got == "" {
		t.Error("a 429 must say when to come back")
	}

	var body ErrorBody
	if err := json.Unmarshal(third.Body.Bytes(), &body); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if body.Code != CodeRateLimited {
		t.Errorf("code: got %q", body.Code)
	}

	// The count is per key, so one noisy caller does not spend another's budget.
	if got := call("b").Code; got != http.StatusOK {
		t.Errorf("another caller: got %d", got)
	}
}

func TestLimiterWindowIsFixed(t *testing.T) {
	l := newLimiter(2, time.Minute)
	start := time.Date(2026, time.September, 6, 14, 0, 0, 0, time.UTC)

	tests := []struct {
		name string
		at   time.Time
		want bool
	}{
		{"first", start, true},
		{"second", start.Add(time.Second), true},
		{"past the cap", start.Add(2 * time.Second), false},
		{"still past it inside the window", start.Add(59 * time.Second), false},
		// Fixed, not sliding: the whole count resets at the boundary rather than aging out.
		{"the window rolls", start.Add(time.Minute), true},
		{"and the count started over", start.Add(time.Minute + time.Second), true},
		{"until the new one fills", start.Add(time.Minute + 2*time.Second), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, got := l.allow("a", tt.at); got != tt.want {
				t.Errorf("allow at %v = %v, want %v", tt.at.Sub(start), got, tt.want)
			}
		})
	}
}

func TestLimiterRetryAfterCountsToTheBoundary(t *testing.T) {
	l := newLimiter(1, time.Minute)
	start := time.Date(2026, time.September, 6, 14, 0, 0, 0, time.UTC)

	l.allow("a", start)
	retryAfter, ok := l.allow("a", start.Add(20*time.Second))
	if ok {
		t.Fatal("want a refusal")
	}
	if retryAfter != 41 {
		t.Errorf("got %d, want 41 seconds to the boundary", retryAfter)
	}
}

// An idle caller must cost nothing to hold, or the limiter becomes the leak it exists to prevent.
func TestLimiterEvictsColdKeys(t *testing.T) {
	l := newLimiter(1, time.Minute)
	start := time.Date(2026, time.September, 6, 14, 0, 0, 0, time.UTC)

	l.allow("cold", start)
	l.allow("warm", start.Add(90*time.Second))
	l.evictBefore(start.Add(time.Minute))

	if _, held := l.seen["cold"]; held {
		t.Error("a rolled-over key is still held")
	}
	if _, held := l.seen["warm"]; !held {
		t.Error("a key inside its window was evicted")
	}
}

// Wrapping must not cost a handler its ability to flush, which is what streaming depends on.
func TestRecorderUnwraps(t *testing.T) {
	h := Chain(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Errorf("Flush: %v", err)
			}
		}),
		Recover(discardLogger()), RequestLog(discardLogger()),
	)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
}

// What wraps a handler: the panic net, the request log, and the rate limiter.

package httpx

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"sync"
	"time"
)

// Middleware is one wrap around a handler.
type Middleware func(http.Handler) http.Handler

// Chain wraps h so that the first middleware is the outermost one and sees every request.
func Chain(h http.Handler, mw ...Middleware) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// Recover turns a panic into the 500 the handler failed to write, and keeps the process up.
func Recover(l *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := &recorder{ResponseWriter: w}

			defer func() {
				raised := recover()
				if raised == nil {
					return
				}
				// A deliberate abort, not a fault: net/http swallows this one on purpose.
				if raised == http.ErrAbortHandler {
					panic(raised)
				}

				l.Error("panic",
					"err", raised,
					"method", r.Method,
					"path", r.URL.Path,
					"requestId", RequestIDFrom(r.Context()),
					"stack", string(debug.Stack()),
				)

				// A status already went out, so the only honest ending is a dead connection —
				// returning normally would frame a truncated body as a complete one.
				if rec.status != 0 {
					panic(http.ErrAbortHandler)
				}
				WriteError(rec, http.StatusInternalServerError, CodeInternal, "internal error")
			}()

			next.ServeHTTP(rec, r)
		})
	}
}

// RequestLog records one line per request, after it ends because that is when the status exists.
func RequestLog(l *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := &recorder{ResponseWriter: w}
			started := time.Now()

			next.ServeHTTP(rec, r)

			level := slog.LevelInfo
			if rec.code() >= http.StatusInternalServerError {
				level = slog.LevelError
			}
			// The path without its query: a ticket and a cursor both end up there, and neither
			// belongs in a log a whole team reads.
			l.LogAttrs(r.Context(), level, "request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.code()),
				slog.Int64("bytes", rec.written),
				slog.Duration("took", time.Since(started)),
				slog.String("requestId", RequestIDFrom(r.Context())),
			)
		})
	}
}

// RateLimit caps how many requests one key may make in a window, and answers 429 past that.
//
// The window is fixed rather than sliding because a fixed one costs a counter per key, where a
// sliding one costs a timestamp per request — the memory a limiter exists to protect. The price is
// a burst across a boundary, which is what max is chosen against.
func RateLimit(max int, window time.Duration, key func(*http.Request) string) Middleware {
	limit := newLimiter(max, window)
	go limit.sweep()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			retryAfter, ok := limit.allow(key(r), time.Now())
			if !ok {
				w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
				WriteError(w, http.StatusTooManyRequests, CodeRateLimited, "too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// recorder keeps what the log needs and tells Recover whether a status already went out.
type recorder struct {
	http.ResponseWriter
	status  int
	written int64
}

func (w *recorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *recorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.written += int64(n)
	return n, err
}

// Unwrap is how http.ResponseController reaches the real writer, so flushing survives the wrap.
func (w *recorder) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// A handler that returned without writing anything still sent the 200 net/http writes for it.
func (w *recorder) code() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

type counter struct {
	hits  int
	start time.Time
}

type limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	seen   map[string]*counter
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, seen: make(map[string]*counter)}
}

// allow reports whether the key may proceed, and how many seconds until its window rolls if not.
func (l *limiter) allow(key string, now time.Time) (int, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	c, ok := l.seen[key]
	if !ok || now.Sub(c.start) >= l.window {
		l.seen[key] = &counter{hits: 1, start: now}
		return 0, true
	}

	c.hits++
	if c.hits <= l.max {
		return 0, true
	}
	return int((l.window - now.Sub(c.start)).Seconds()) + 1, false
}

// sweep runs for the life of the process: a limiter is built once, at startup, and never replaced.
func (l *limiter) sweep() {
	tick := time.NewTicker(l.window)
	defer tick.Stop()

	for now := range tick.C {
		l.evictBefore(now.Add(-l.window))
	}
}

// evictBefore drops keys whose window has already rolled, so an idle caller costs nothing to hold.
func (l *limiter) evictBefore(cutoff time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()

	for key, c := range l.seen {
		if c.start.Before(cutoff) {
			delete(l.seen, key)
		}
	}
}

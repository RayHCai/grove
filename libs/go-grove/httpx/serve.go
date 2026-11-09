// The listener: what binds the port, what a supervisor polls, and the drain on the way down.

package httpx

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Covers the longest deadline any route may set for itself, so an ordinary rolling restart finishes
// what is in flight instead of being recorded as a failed drain.
const drainTimeout = 30 * time.Second

// A client that opens a connection and sends no header holds a goroutine until this fires.
const readHeaderTimeout = 10 * time.Second

// Header and body together, against the megabyte a state write may carry: a floor near 70 KB/s,
// which no link inside the fleet is under.
const readTimeout = 15 * time.Second

// Absolute from the end of the header read rather than idle, so it bounds the handler too; a
// route that legitimately blocks longer sets its own with http.ResponseController.
const writeTimeout = 25 * time.Second

// Set rather than left to fall back to ReadTimeout, which is sized for a body arriving and not
// for a connection resting, and above the ninety seconds a Go client keeps one so the client
// closes first.
const idleTimeout = 120 * time.Second

// A bearer is the largest header any of these services reads, and the default megabyte is memory a
// caller can spend before anything has authenticated it.
const maxHeaderBytes = 16 << 10

// A probe that hangs must not turn the route asking whether this process is stuck into one more
// place it can get stuck.
const readyTimeout = 2 * time.Second

// newServer is the listener's whole configuration, in one place a test can read back: four
// deadlines that are only correct together are four a reader has to be able to see at once.
func newServer(h http.Handler, l *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(l.Handler(), slog.LevelWarn),
	}
}

// Health is what a supervisor polls. It reports that this process is listening, and nothing else.
func Health(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Ready reports whether this process should be given work, where Health reports only that it is up.
//
// The probe is supplied at composition because what readiness means is the service's answer and not
// this package's: a store that has to respond, a binary that has to be forkable, or nothing at all.
func Ready(probe func(context.Context) error, l *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyTimeout)
		defer cancel()

		if err := probe(ctx); err != nil {
			// A 5xx body says nothing about itself, so this line is the only account of why.
			l.ErrorContext(ctx, "not ready", "err", err, "requestId", RequestIDFrom(ctx))
			WriteError(w, http.StatusServiceUnavailable, CodeInternal, "not ready")
			return
		}
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// Service is every service's handler: the open probes, one /v1 scope behind gate, and the shared 404.
func Service(scope *http.ServeMux, ready func(context.Context) error, l *slog.Logger, gate ...Middleware) http.Handler {
	// Inside the gate, so a caller without a credential cannot map the scope's routes by their 404s.
	scope.HandleFunc("/v1/", NotFound)

	root := http.NewServeMux()
	root.HandleFunc("GET /health", Health)
	root.HandleFunc("GET /ready", Ready(ready, l))
	root.Handle("/v1/", Chain(scope, gate...))
	root.HandleFunc("/", NotFound)

	// RequestLog outside Recover, so a panic's 500 still gets its access line.
	return Chain(root, RequestID(), RequestLog(l), Recover(l))
}

// Listener is one address a service binds: plaintext unless TLS is set, and uncapped unless
// MaxConns is.
type Listener struct {
	Addr     string
	Handler  http.Handler
	TLS      *tls.Config
	MaxConns int
	// How long a request head may take to arrive, readHeaderTimeout when zero.
	HeaderTimeout time.Duration
}

// Serve listens on one plaintext address until ctx is done or a signal arrives, then drains.
func Serve(ctx context.Context, addr string, h http.Handler, l *slog.Logger) error {
	return ServeAll(ctx, l, Listener{Addr: addr, Handler: h})
}

// ServeAll binds every listener before serving any, and drains them together on the way down.
//
// The drain is what makes a rolling deploy invisible (a request already inside a handler runs to
// its end), and is this service's half of what the Fastify ones do with `app.close()`.
func ServeAll(ctx context.Context, l *slog.Logger, listeners ...Listener) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// All bound before any serves, so a port already taken is an error this returns instead of a
	// service that came up half-listening.
	bound := make([]net.Listener, 0, len(listeners))
	defer func() {
		for _, b := range bound {
			_ = b.Close()
		}
	}()
	for _, ln := range listeners {
		raw, err := net.Listen("tcp", ln.Addr)
		if err != nil {
			return fmt.Errorf("listen on %s: %w", ln.Addr, err)
		}
		bound = append(bound, raw)
	}

	servers := make([]*http.Server, len(listeners))
	serving := make(chan error, len(listeners))
	for i, ln := range listeners {
		listener := capConns(bound[i], ln.MaxConns)
		if ln.TLS != nil {
			if ln.TLS.GetCertificate == nil && len(ln.TLS.Certificates) == 0 {
				return fmt.Errorf("serve on %s: %w", ln.Addr, errNoCertificate)
			}
			listener = tls.NewListener(listener, ln.TLS)
		}
		servers[i] = newServer(ln.Handler, l)
		if ln.HeaderTimeout > 0 {
			servers[i].ReadHeaderTimeout = ln.HeaderTimeout
		}
		go func() { serving <- servers[i].Serve(listener) }()
		l.Info("listening", "addr", bound[i].Addr().String(), "tls", ln.TLS != nil)
	}

	select {
	case err := <-serving:
		if !errors.Is(err, http.ErrServerClosed) {
			drainAll(ctx, servers, l)
			return fmt.Errorf("serve: %w", err)
		}
	case <-ctx.Done():
	}

	// The second signal goes back to the default handler, so an operator can always end a drain
	// that a stuck handler is holding open.
	stop()
	return drainAll(ctx, servers, l)
}

func drainAll(ctx context.Context, servers []*http.Server, l *slog.Logger) error {
	l.Info("draining", "timeout", drainTimeout)

	drain, cancel := context.WithTimeout(context.WithoutCancel(ctx), drainTimeout)
	defer cancel()

	var failed []error
	for _, srv := range servers {
		if err := srv.Shutdown(drain); err != nil {
			_ = srv.Close()
			failed = append(failed, err)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("drain: %w", errors.Join(failed...))
	}
	return nil
}

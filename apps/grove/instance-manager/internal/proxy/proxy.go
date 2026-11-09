// Package proxy is the one door players have into this box: a world's socket, carried from the
// public listener to that world's child on loopback.
package proxy

import (
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// HeaderTimeout is how long a player's request head may take, inside the child's own 5 seconds.
const HeaderTimeout = 4 * time.Second

// A fresh connection per upgrade: the stdlib replays a GET whose reused connection failed, and a
// replayed upgrade spends a single-use ticket twice.
var toChild = &http.Transport{
	Proxy:                 nil,
	DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
	DisableKeepAlives:     true,
	ResponseHeaderTimeout: 10 * time.Second,
}

// Worlds is the half of the supervisor the proxy reads: which loopback port a live world is on.
type Worlds interface {
	Port(instanceID string) (int, bool)
}

type proxy struct {
	worlds Worlds
	log    *slog.Logger
}

// New is the whole public surface: `GET /play/{instanceId}` and a health check, nothing else.
func New(worlds Worlds, l *slog.Logger) http.Handler {
	p := &proxy{worlds: worlds, log: l}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /play/{instanceId}", p.play)
	mux.HandleFunc("GET /health", httpx.Health)
	mux.HandleFunc("/", httpx.NotFound)

	return httpx.Chain(mux, httpx.RequestID(), httpx.RequestLog(l), httpx.Recover(l))
}

func (p *proxy) play(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("instanceId")
	port, ok := 0, contract.ValidUUID(id)
	if ok {
		port, ok = p.worlds.Port(id)
	}
	if !ok {
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "no such world")
		return
	}

	// An upgraded socket lives as long as the game does, past every deadline a request is held to;
	// the child's own keepalive is what ends a dead one.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	forward := &httputil.ReverseProxy{
		Transport: toChild,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// The child serves one route, so only the path changes; the ticket's subprotocol passes as sent.
			pr.Out.URL.Path, pr.Out.URL.RawPath = "/play", ""
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			pr.SetXForwarded()
			pr.Out.Header.Set(contract.RequestIDHeader, httpx.RequestIDFrom(pr.In.Context()))
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			p.log.WarnContext(r.Context(), "world unreachable",
				"err", err, "instanceId", id, "requestId", httpx.RequestIDFrom(r.Context()))
			httpx.WriteError(w, http.StatusBadGateway, httpx.CodeInternal, "world unreachable")
		},
	}
	forward.ServeHTTP(w, r)
}

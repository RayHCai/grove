// Package api is the routing table: the fleet-bearer gate, the four routes behind it, and the two
// open ones.
package api

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// Large enough for a box reporting every instance it runs, small enough that a wrong caller cannot
// spend this service's memory on one request.
const maxBodyBytes = 64 << 10

// Options is what main composes a Server from, and what a test substitutes into.
type Options struct {
	Registry *fleet.Registry
	// The line every join waits in, which holds the placement decision behind it.
	Joins *joins.Line
	// What this service says to a box, and the only thing it ever says.
	Agent  fleet.Agent
	Secret []byte
	Log    *slog.Logger
	// How long a whole fan-out may take, and how long any one box in it may hold its own answer.
	DeployTimeout time.Duration
	HostTimeout   time.Duration
	// The clock the staleness window is measured against, so a test can age a host without waiting.
	Now func() time.Time
	// The probe GET /ready answers from, so a test can substitute one that fails where this
	// service's own never does.
	Ready func(context.Context) error
}

// Server holds what a handler needs and nothing else.
type Server struct {
	registry      *fleet.Registry
	joins         *joins.Line
	agent         fleet.Agent
	secret        []byte
	log           *slog.Logger
	deployTimeout time.Duration
	hostTimeout   time.Duration
	now           func() time.Time
	ready         func(context.Context) error
}

func New(o Options) *Server {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Ready == nil {
		o.Ready = nothingToWaitFor
	}
	return &Server{
		registry:      o.Registry,
		joins:         o.Joins,
		agent:         o.Agent,
		secret:        o.Secret,
		log:           o.Log,
		deployTimeout: o.DeployTimeout,
		hostTimeout:   o.HostTimeout,
		now:           o.Now,
		ready:         o.Ready,
	}
}

// Handler is the whole service: health and readiness outside the gate, everything else behind it.
func (s *Server) Handler() http.Handler {
	v1 := http.NewServeMux()
	v1.HandleFunc("POST /v1/hosts/{hostId}/heartbeat", s.heartbeat)
	v1.HandleFunc("GET /v1/hosts", s.listHosts)
	v1.HandleFunc("POST /v1/placements", s.place)
	v1.HandleFunc("POST /v1/deployments", s.deploy)
	v1.HandleFunc("/", httpx.NotFound)

	root := http.NewServeMux()
	// Outside the gate: a supervisor polls these before the process has any credential to check.
	root.HandleFunc("GET /health", httpx.Health)
	root.HandleFunc("GET /ready", httpx.Ready(s.ready, s.log))
	root.Handle("/v1/", httpx.Chain(v1, requireFleet(s.secret)))
	root.HandleFunc("/", httpx.NotFound)

	return httpx.Chain(root, httpx.RequestID(), httpx.Recover(s.log), httpx.RequestLog(s.log))
}

// requireFleet admits only a caller holding the shared fleet bearer.
//
// A different secret from GAME_TOKEN_SECRET, and deliberately so: that one signs a browser's join
// ticket, where this service is reachable only from inside the fleet and never sees one.
func requireFleet(secret []byte) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			presented, ok := token.Bearer(r)
			// Constant time, so a caller cannot learn the secret one leading byte per request.
			if !ok || subtle.ConstantTimeCompare([]byte(presented), secret) != 1 {
				httpx.WriteError(w, http.StatusUnauthorized, httpx.CodeUnauthorized,
					"fleet credential required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// nothingToWaitFor is this service's readiness probe, and it never fails. An empty registry
// answers a placement with the same 409 a full fleet does, and a caller that pulled this process
// from rotation would cut off the beats that are the only way the registry fills.
func nothingToWaitFor(context.Context) error { return nil }

// remoteIP is where a beat came from, without the connection's ephemeral source port.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

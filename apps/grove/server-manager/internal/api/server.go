// Package api is the routing table: two credentials, the four routes each one opens, and the two
// open ones.
package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// Large enough for a box reporting every instance it runs, small enough that a wrong caller cannot
// spend this service's memory on one request.
const maxBodyBytes = 64 << 10

// Options is what main composes a Server from, and what a test substitutes into.
type Options struct {
	Registry *fleet.Registry
	// The line every join waits in, which holds the placement decision behind it.
	Joins *joins.Line
	// How a redeploy reaches each box; a join's start goes through the line's Router instead.
	Agent fleet.Agent
	// The boxes' bearer, which opens the heartbeat and nothing a caller uses.
	FleetSecret []byte
	// @grove/api's bearer, which opens placements, deployments and the fleet listing.
	CallerSecret []byte
	// Whether a beat must name its box, which behind a proxy its source address never does.
	Production bool
	// How long after boot an empty answer is a 503 rather than a full fleet.
	Warmup time.Duration
	// How long a box that left a redeploy unanswered is routed around.
	SuspectFor time.Duration
	Log        *slog.Logger
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
	fleetSecret   []byte
	callerSecret  []byte
	production    bool
	warmEnds      time.Time
	suspectFor    time.Duration
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
		fleetSecret:   o.FleetSecret,
		callerSecret:  o.CallerSecret,
		production:    o.Production,
		warmEnds:      o.Now().Add(o.Warmup),
		suspectFor:    o.SuspectFor,
		log:           o.Log,
		deployTimeout: o.DeployTimeout,
		hostTimeout:   o.HostTimeout,
		now:           o.Now,
		ready:         o.Ready,
	}
}

// Handler is the whole service: health and readiness outside the gate, everything else behind it.
func (s *Server) Handler() http.Handler {
	box := httpx.SharedSecret(s.log, s.fleetSecret)
	caller := httpx.SharedSecret(s.log, s.callerSecret)

	v1 := http.NewServeMux()
	v1.Handle("POST /v1/hosts/{hostId}/heartbeat", box(http.HandlerFunc(s.heartbeat)))
	v1.Handle("GET /v1/hosts", caller(http.HandlerFunc(s.listHosts)))
	v1.Handle("POST /v1/placements", caller(http.HandlerFunc(s.place)))
	v1.Handle("POST /v1/deployments", caller(http.HandlerFunc(s.deploy)))

	// Either credential opens the scope, so a caller holding neither cannot map it by its 404s.
	return httpx.Service(v1, s.ready, s.log, httpx.SharedSecret(s.log, s.fleetSecret, s.callerSecret))
}

// nothingToWaitFor is this service's readiness probe, and it never fails: a caller that pulled
// this process from rotation would cut off the beats that are the only way the registry fills.
func nothingToWaitFor(context.Context) error { return nil }

// remoteIP is where a beat came from, without the connection's ephemeral source port.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

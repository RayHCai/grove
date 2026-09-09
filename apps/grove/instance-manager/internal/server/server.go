// Package server is the whole surface this agent answers on: two open routes, and one scope the
// fleet's shared bearer opens.
package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/supervisor"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

type service struct {
	instances *supervisor.Registry
	log       *slog.Logger
}

// New builds the handler: the two open routes, the fleet scope, and the wraps around both.
//
// Nothing at this level decides who may call what — the scope carries the only check there is, so
// a route mounted outside it starts open and a route mounted inside it starts closed.
func New(
	instances *supervisor.Registry,
	ready func(context.Context) error,
	fleetSecret []byte,
	l *slog.Logger,
) http.Handler {
	s := &service{instances: instances, log: l}

	scope := http.NewServeMux()
	scope.HandleFunc("POST /v1/instances", s.startInstance)
	scope.HandleFunc("GET /v1/instances", s.listInstances)
	scope.HandleFunc("GET /v1/instances/{instanceId}", s.readInstance)
	scope.HandleFunc("DELETE /v1/instances/{instanceId}", s.stopInstance)
	scope.HandleFunc("GET /v1/instances/{instanceId}/logs", s.readLogs)
	// A wrong path under the scope answers only once the bearer has, so a caller without one cannot
	// map the routes from here.
	scope.HandleFunc("/v1/", httpx.NotFound)

	root := http.NewServeMux()
	// Polled by whatever supervises this agent on the box, which holds no fleet secret.
	root.HandleFunc("GET /health", httpx.Health)
	// A box that can accept a start request and then fail every one of them should be given none.
	root.HandleFunc("GET /ready", httpx.Ready(ready, l))
	root.Handle("/v1/", httpx.Chain(scope, fleetBearer(fleetSecret, l)))
	root.HandleFunc("/", httpx.NotFound)

	return httpx.Chain(root, httpx.RequestID(), httpx.Recover(l), httpx.RequestLog(l))
}

// bad is the 400 a request that never reaches the supervisor gets.
func bad(w http.ResponseWriter, message string) {
	httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, message)
}

// fail keeps what went wrong here and tells the caller only that something did.
func (s *service) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	s.log.ErrorContext(r.Context(), what,
		"err", err, "path", r.URL.Path, "requestId", httpx.RequestIDFrom(r.Context()))
	httpx.WriteError(w, http.StatusInternalServerError, httpx.CodeInternal, "internal error")
}

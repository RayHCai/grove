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
	// The id the fleet knows this box by, which the box names in the row it answers a redeploy with.
	hostID string
	log    *slog.Logger
}

// New builds the handler. A box that can accept a start and then fail every one should be given
// none, which is what ready answers.
func New(
	instances *supervisor.Registry,
	ready func(context.Context) error,
	fleetSecret []byte,
	hostID string,
	l *slog.Logger,
) http.Handler {
	s := &service{instances: instances, hostID: hostID, log: l}

	scope := http.NewServeMux()
	scope.HandleFunc("POST /v1/instances", s.startInstance)
	scope.HandleFunc("GET /v1/instances", s.listInstances)
	scope.HandleFunc("GET /v1/instances/{instanceId}", s.readInstance)
	scope.HandleFunc("DELETE /v1/instances/{instanceId}", s.stopInstance)
	scope.HandleFunc("GET /v1/instances/{instanceId}/logs", s.readLogs)
	scope.HandleFunc("POST /v1/games/{gameId}/redeploy", s.redeployGame)

	return httpx.Service(scope, ready, l, httpx.FleetBearer(fleetSecret, l))
}

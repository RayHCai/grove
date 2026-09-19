// The game processes on this box: starting one, reading one, ending one, and reading what one said.

package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/supervisor"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const (
	maxBodyBytes    = 16 * 1024
	logLimitDefault = 200
)

// What the 204 gets on top of the drain: a child that ignored the signal is killed at the end of
// the supervisor's budget and still has to be reaped before Stop returns.
const stopWriteGrace = 10 * time.Second

// startBody is one placement @grove/server-manager already decided. This agent carries it out; it
// does not weigh it, because which box should hold a session is not a question one box can answer.
type startBody struct{ contract.InstanceStart }

type logPage struct {
	InstanceID string   `json:"instanceId"`
	Lines      []string `json:"lines"`
}

type instanceList struct {
	Instances []supervisor.View `json:"instances"`
}

func (s *service) startInstance(w http.ResponseWriter, r *http.Request) {
	var body startBody
	if !httpx.DecodeJSON(w, r, &body, maxBodyBytes) {
		return
	}
	if problem := body.problem(); problem != "" {
		bad(w, problem)
		return
	}

	view, err := s.instances.Start(r.Context(), supervisor.Request{
		InstanceID: body.InstanceID,
		GameID:     body.GameID,
		SessionID:  body.SessionID,
		Revision:   body.Revision,
		Bundles:    body.Bundles,
		// This box's own, never the placement's: where the data plane is, is a fleet address, and
		// @grove/server-manager holds no game data to be restating one.
		ManagerURL: s.managerURL,
	})
	switch {
	case errors.Is(err, supervisor.ErrAtCapacity):
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "host is at its instance cap")
		return
	case err != nil:
		s.fail(w, r, "start an instance", err)
		return
	}

	httpx.WriteJSON(w, http.StatusCreated, view)
}

func (s *service) listInstances(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, instanceList{Instances: s.instances.List()})
}

func (s *service) readInstance(w http.ResponseWriter, r *http.Request) {
	view, err := s.instances.Get(r.PathValue("instanceId"))
	if err != nil {
		notFound(w)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, view)
}

func (s *service) stopInstance(w http.ResponseWriter, r *http.Request) {
	// Stop blocks for the whole drain, which outlasts the deadline the other routes are written
	// under. Ignored because the only writer with no connection beneath it is a test's recorder.
	budget := s.instances.StopTimeout() + stopWriteGrace
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(budget))

	err := s.instances.Stop(r.Context(), r.PathValue("instanceId"))
	switch {
	case errors.Is(err, supervisor.ErrUnknown):
		notFound(w)
		return
	case err != nil:
		s.fail(w, r, "stop an instance", err)
		return
	}

	// 204 rather than the last report: the process is gone, and what it was is no longer a thing
	// this box can answer for.
	w.WriteHeader(http.StatusNoContent)
}

func (s *service) readLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("instanceId")

	limit := logLimitDefault
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			bad(w, "limit must be a whole number")
			return
		}
		limit = parsed
	}

	lines, err := s.instances.Logs(id, limit)
	if err != nil {
		notFound(w)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, logPage{InstanceID: id, Lines: lines})
}

func notFound(w http.ResponseWriter) {
	httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "no such instance")
}

// The ids are checked here because a child is spawned with them: a game process refuses a ticket
// naming another game, and it can only do that if the id it was started with is the real one.
func (b startBody) problem() string {
	switch {
	case !contract.ValidUUID(b.GameID):
		return "gameId must be a uuid"
	case !contract.ValidUUID(b.SessionID):
		return "sessionId must be a uuid"
	case !contract.ValidUUID(b.InstanceID):
		return "instanceId must be a uuid"
	case b.Revision < 1:
		return "revision must be positive"
	// The hashes are checked here because they become filenames under this box's cache directory,
	// and they are the only part of a start that reaches its filesystem at all.
	case !contract.ValidContentHash(b.Bundles.Server.Hash):
		return "bundles.server.hash must be a sha-256"
	case !contract.ValidContentHash(b.Bundles.SimConfig.Hash):
		return "bundles.simConfig.hash must be a sha-256"
	case !contract.ValidURL(b.Bundles.Server.URL):
		return "bundles.server.url must be a url"
	case !contract.ValidURL(b.Bundles.SimConfig.URL):
		return "bundles.simConfig.url must be a url"
	}
	return ""
}

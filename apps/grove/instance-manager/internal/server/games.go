// What a new version of a game does to the worlds of it already running on this box.

package server

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// redeployGame drains the worlds of one game not on the pushed revision and answers what it marked.
//
// The body names only the revision: what a box runs is decided at start, from the refs its start
// carries, and a bundle sent here would be state this agent has nowhere to keep.
func (s *service) redeployGame(w http.ResponseWriter, r *http.Request) {
	gameID := r.PathValue("gameId")
	if !contract.ValidUUID(gameID) {
		httpx.BadRequest(w, "gameId must be a uuid")
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		httpx.BadRequest(w, "body must be at most 16 KiB")
		return
	}
	// An empty body is every world of the game, which is what an operator clearing one sends.
	var push contract.RedeployRequest
	if len(raw) > 0 && (json.Unmarshal(raw, &push) != nil || push.Revision < 0) {
		httpx.BadRequest(w, "body must be {\"revision\": a non-negative integer}")
		return
	}

	marked := s.instances.Redeploy(gameID, push.Revision, time.Now())

	// Skipped rather than 404: a box holding no world of a game is a box with nothing to end, which
	// is a fine outcome for a rollout and not a wrong address.
	status := contract.DeploySkipped
	if len(marked) > 0 {
		status = contract.DeployDraining
	}

	httpx.WriteJSON(w, http.StatusOK, contract.HostDeployment{
		HostID:      s.hostID,
		InstanceIDs: marked,
		Status:      status,
	})
}

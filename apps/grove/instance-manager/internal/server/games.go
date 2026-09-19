// What a new version of a game does to the worlds of it already running on this box.

package server

import (
	"net/http"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// redeployGame puts every world of one game on this box into drain and answers what it marked.
//
// No body: what a box runs is decided at start, from the paths its start request carries, and a
// bundle sent here would be state this agent has nowhere to keep and would lose on its own restart.
func (s *service) redeployGame(w http.ResponseWriter, r *http.Request) {
	gameID := r.PathValue("gameId")
	if !contract.ValidUUID(gameID) {
		bad(w, "gameId must be a uuid")
		return
	}

	marked := s.instances.Redeploy(gameID, time.Now())

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

// The hot path into a game: one read of the registry, one ranking, no call to any box.

package api

import (
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// place answers where a joining player should dial.
//
// @grove/api calls this before it signs a ticket, so it is on every join. It is served from the
// heartbeats already in hand — asking the fleet at request time would put the slowest box in the
// fleet on the critical path of every player who ever joins.
func (s *Server) place(w http.ResponseWriter, r *http.Request) {
	var req contract.PlacementRequest
	if !httpx.DecodeJSON(w, r, &req, maxBodyBytes) {
		return
	}
	if problem, ok := checkPlacement(req); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, problem)
		return
	}

	// A box already running the game wins over an emptier one, and the ranking never gets a say:
	// a game is a world its players share, and MostFree would send the second player to the box
	// with the most free slots — which is never the box already spending one on this game.
	if host, running, serving := s.registry.Serving(req.GameID, req.Region, s.now()); serving {
		httpx.WriteJSON(w, http.StatusOK, contract.Placement{
			HostID:     host.ID,
			InstanceID: running.InstanceID,
			SessionID:  running.SessionID,
			ServerURL:  s.ingress.URL(host, running.InstanceID),
		})
		return
	}

	// Nothing is running the game, so this is where it starts, and ranking decides where.
	host, ok := s.balancer.Pick(r.Context(), req, s.registry.Candidates(req.Region, s.now()))
	if !ok {
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "no capacity")
		return
	}

	instanceID, sessionID := contract.NewUUID(), contract.NewUUID()
	httpx.WriteJSON(w, http.StatusOK, contract.Placement{
		HostID:     host.ID,
		InstanceID: instanceID,
		SessionID:  sessionID,
		ServerURL:  s.ingress.URL(host, instanceID),
	})
}

func checkPlacement(req contract.PlacementRequest) (string, bool) {
	if !contract.ValidUUID(req.GameID) {
		return "gameId must be a uuid", false
	}
	if !contract.ValidUUID(req.PlayerID) {
		return "playerId must be a uuid", false
	}
	if len(req.Region) > contract.RegionMaxLen {
		return "region must be at most 32 characters", false
	}
	return "", true
}

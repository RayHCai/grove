// The hot path into a game: one ranking, one record of where it went, and no call to any box.

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

	// Ranked outside the lock the decision below takes: a Balancer is handed a context because an
	// implementation may go and ask something, and no join may hold the fleet while it does.
	ordered := s.balancer.Rank(r.Context(), req, s.registry.Candidates(req.Region, s.now()))

	placed, ok := s.registry.Place(req, ordered, s.now())
	if !ok {
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "no capacity")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, contract.Placement{
		HostID:     placed.Host.ID,
		InstanceID: placed.InstanceID,
		SessionID:  placed.SessionID,
		ServerURL:  s.ingress.URL(placed.Host, placed),
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

// The hot path into a game: one place in the line, one ranking, and no call to any box.

package api

import (
	"errors"
	"net/http"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// place answers where a joining player should dial. @grove/api calls this before it signs a
// ticket, so it is on every join: the answer comes from heartbeats already in hand, since asking
// the fleet would put its slowest box on every player's critical path.
func (s *Server) place(w http.ResponseWriter, r *http.Request) {
	var req contract.PlacementRequest
	if !httpx.DecodeJSON(w, r, &req, maxBodyBytes) {
		return
	}
	if problem, ok := checkPlacement(req); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, problem)
		return
	}

	placed, err := s.joins.Join(r.Context(), req)
	switch {
	case errors.Is(err, joins.ErrNoCapacity):
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "no capacity")
		return
	case err != nil:
		// 500 and never 409: a line this service could not push onto is this service failing, and
		// @grove/api reads a 409 as a full fleet — which is the one wrong answer available here.
		s.log.ErrorContext(r.Context(), "join the line",
			"err", err, "gameId", req.GameID, "requestId", httpx.RequestIDFrom(r.Context()))
		httpx.WriteError(w, http.StatusInternalServerError, httpx.CodeInternal, "internal error")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, placed)
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
	// Checked here rather than left to the box: a join with no version names no world to join and
	// no code to start one on, and the box would refuse it a whole round trip later.
	if req.Revision < 1 {
		return "revision must be positive", false
	}
	if problem, ok := checkBundleSet(req.Bundles); !ok {
		return problem, false
	}
	return "", true
}

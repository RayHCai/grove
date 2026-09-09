// The widest response this service returns, and the only one that pages.

package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

func (s *service) readLeaderboard(w http.ResponseWriter, r *http.Request) {
	query, ok := leaderboardQuery(w, r)
	if !ok {
		return
	}

	page, err := s.store.Leaderboard(r.Context(), gameID(r), query)
	switch {
	case errors.Is(err, store.ErrBadCursor):
		bad(w, "cursor is not one this board issued")
	case err != nil:
		s.fail(w, r, "read leaderboard", err)
	default:
		httpx.WriteJSON(w, http.StatusOK, page)
	}
}

func leaderboardQuery(w http.ResponseWriter, r *http.Request) (contract.LeaderboardQuery, bool) {
	params := r.URL.Query()

	board := params.Get("board")
	if board == "" || len(board) > contract.LeaderboardNameMaxLen {
		bad(w, fmt.Sprintf("board must be 1 to %d characters", contract.LeaderboardNameMaxLen))
		return contract.LeaderboardQuery{}, false
	}

	limit := contract.LeaderboardLimitDefault
	if raw := params.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			bad(w, "limit must be an integer")
			return contract.LeaderboardQuery{}, false
		}
		// Clamped rather than refused: a caller asking for more rows than a page holds wants the
		// page, and paging is what the cursor is for.
		limit = min(max(parsed, 1), contract.LeaderboardLimitMax)
	}

	return contract.LeaderboardQuery{Board: board, Limit: limit, Cursor: params.Get("cursor")}, true
}

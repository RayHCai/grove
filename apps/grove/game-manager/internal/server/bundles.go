// Where a session learns which code every peer must be running.

package server

import (
	"errors"
	"net/http"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// The bundles themselves are fetched from the urls this returns, never through here — a service
// that proxied multi-megabyte chunks would be on the join path for every player of every game.
func (s *service) readBundles(w http.ResponseWriter, r *http.Request) {
	set, err := s.store.Bundles(r.Context(), gameID(r))
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "never published")
	case err != nil:
		s.fail(w, r, "read bundles", err)
	default:
		httpx.WriteJSON(w, http.StatusOK, set)
	}
}

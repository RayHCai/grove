// `@serverState`, as the engine's KVStore seam reaches it over HTTP.

package server

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// One megabyte, the limit the Fastify services carry, so a value that crosses one crosses the other.
const maxStateBody = 1 << 20

// written is the whole of a successful write: a caller compares the revision, not the value it sent.
type written struct {
	Revision int64 `json:"revision"`
}

func (s *service) readState(w http.ResponseWriter, r *http.Request) {
	key, ok := stateKey(w, r)
	if !ok {
		return
	}

	record, err := s.store.Read(r.Context(), gameID(r), key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "no such key")
	case err != nil:
		s.fail(w, r, "read state", err)
	default:
		httpx.WriteJSON(w, http.StatusOK, record)
	}
}

func (s *service) writeState(w http.ResponseWriter, r *http.Request) {
	key, ok := stateKey(w, r)
	if !ok {
		return
	}

	var write contract.StateWrite
	if !httpx.DecodeJSON(w, r, &write, maxStateBody) {
		return
	}
	if len(write.Value) == 0 {
		bad(w, "value is required")
		return
	}
	if write.IfRevision != nil && *write.IfRevision < 0 {
		bad(w, "ifRevision must not be negative")
		return
	}

	revision, err := s.store.Write(r.Context(), gameID(r), key, write)
	switch {
	// A write against a stale revision is refused rather than applied: two ticks racing on one key
	// is a bug the caller has to see, not one to paper over.
	case errors.Is(err, store.ErrStale):
		httpx.WriteError(w, http.StatusConflict, httpx.CodeConflict, "revision moved")
	case err != nil:
		s.fail(w, r, "write state", err)
	default:
		httpx.WriteJSON(w, http.StatusOK, written{Revision: revision})
	}
}

// The key a request names, bounded exactly as `StateKeyParams` bounds it.
func stateKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := r.PathValue("key")
	if key == "" || len(key) > contract.StateKeyMaxLen {
		bad(w, fmt.Sprintf("key must be 1 to %d characters", contract.StateKeyMaxLen))
		return "", false
	}
	return key, true
}

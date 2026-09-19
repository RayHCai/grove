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

// One megabyte, the Fastify services' limit, so a value crossing one crosses the other.
const maxStateBody = 1 << 20

// written is the whole of a successful write: a caller compares the revision, not its value.
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
	// Never the 409 a stale write answers: @grove/game-instance reads that as a lost race and
	// re-reads, re-writes and retries into the store that just refused it.
	case errors.Is(err, store.ErrTooManyKeys):
		atBound(w, "game holds as many keys as it may")
	case errors.Is(err, store.ErrGameFull):
		atBound(w, "game holds as many bytes as it may")
	case err != nil:
		s.fail(w, r, "write state", err)
	default:
		httpx.WriteJSON(w, http.StatusOK, written{Revision: revision})
	}
}

func (s *service) deleteState(w http.ResponseWriter, r *http.Request) {
	key, ok := stateKey(w, r)
	if !ok {
		return
	}

	err := s.store.Delete(r.Context(), gameID(r), key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, httpx.CodeNotFound, "no such key")
	case err != nil:
		s.fail(w, r, "delete state", err)
	default:
		w.WriteHeader(http.StatusNoContent)
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

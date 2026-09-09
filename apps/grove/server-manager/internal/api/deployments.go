// Where a new version of a game goes: which boxes take it.

package api

import (
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// deploy answers with the boxes the version reached. Fewer than the fleet is a staged rollout, and
// none at all is a fleet with nothing healthy in the requested regions — both are the same answer.
func (s *Server) deploy(w http.ResponseWriter, r *http.Request) {
	var req contract.DeploymentRequest
	if !httpx.DecodeJSON(w, r, &req, maxBodyBytes) {
		return
	}
	if problem, ok := checkDeployment(req); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, problem)
		return
	}

	httpx.WriteJSON(w, http.StatusOK, s.registry.Deploy(req, s.now()))
}

func checkDeployment(req contract.DeploymentRequest) (string, bool) {
	if !contract.ValidUUID(req.GameID) {
		return "gameId must be a uuid", false
	}
	if problem, ok := checkBundle(req.Bundles.Server, contract.SideServer); !ok {
		return problem, false
	}
	if problem, ok := checkBundle(req.Bundles.Client, contract.SideClient); !ok {
		return problem, false
	}
	// The hash both halves were built from. A session compares it at the handshake, so a set whose
	// two halves came from different sources must not reach a box at all.
	if !contract.ValidContentHash(req.Bundles.SyncedHash) {
		return "bundles.syncedHash must be a content hash", false
	}
	for _, region := range req.Regions {
		if region == "" || len(region) > contract.RegionMaxLen {
			return "every region must be set and at most 32 characters", false
		}
	}
	return "", true
}

func checkBundle(ref contract.BundleRef, side contract.BundleSide) (string, bool) {
	if ref.Side != side {
		return "bundles." + string(side) + " must carry side " + string(side), false
	}
	if !contract.ValidContentHash(ref.Hash) {
		return "bundles." + string(side) + ".hash must be a content hash", false
	}
	if !contract.ValidURL(ref.URL) {
		return "bundles." + string(side) + ".url must be a url", false
	}
	if ref.ByteLength <= 0 {
		return "bundles." + string(side) + ".byteLength must be positive", false
	}
	return "", true
}

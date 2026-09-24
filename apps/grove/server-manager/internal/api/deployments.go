// Where a new version of a game goes: every box holding a world of it, asked at once.

package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// The fan-out outlasts the listener's own write deadline on a fleet of any size, and losing the
// connection here loses the account of what drained rather than the drain.
const deployWriteGrace = 5 * time.Second

// deploy forwards the redeploy to every box running the game and answers what each one did.
//
// This service deploys nothing: what a box runs is decided at start, from the paths its start
// request carries, so the whole of this is a relay with a report attached.
func (s *Server) deploy(w http.ResponseWriter, r *http.Request) {
	var req contract.DeploymentRequest
	if !httpx.DecodeJSON(w, r, &req, maxBodyBytes) {
		return
	}
	if problem, ok := checkDeployment(req); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, problem)
		return
	}

	// Past httpx's own writeTimeout, which is sized for a request and not for a fleet.
	budget := s.deployTimeout + deployWriteGrace
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(budget))

	ctx, cancel := context.WithTimeout(r.Context(), s.deployTimeout)
	defer cancel()

	rows := s.fanOut(ctx, s.registry.Targets(req, s.now()), req.GameID)

	// 200 even when every row failed: httpx.WriteError scrubs the body of any 5xx, and a 502 here
	// would erase the report this route exists to deliver.
	httpx.WriteJSON(w, http.StatusOK, contract.Deployment{
		GameID:     req.GameID,
		Bundles:    req.Bundles,
		Hosts:      rows,
		DeployedAt: contract.Timestamp(s.now()),
	})
}

// fanOut asks every target at once and keeps each answer in its target's place.
//
// One goroutine per box and no bound on how many run: each is one short-lived connection, and
// bounding them would make the wall clock a function of fleet size while a rollout waits.
func (s *Server) fanOut(ctx context.Context, targets []fleet.Host, gameID string) []contract.HostDeployment {
	rows := make([]contract.HostDeployment, len(targets))

	var asking sync.WaitGroup
	for i, host := range targets {
		asking.Add(1)
		go func() {
			defer asking.Done()

			// Its own budget inside the whole fan-out's, so a handful of wedged boxes cannot spend
			// the deadline every other box is still waiting on and turn healthy ones into failures.
			hostCtx, cancel := context.WithTimeout(ctx, s.hostTimeout)
			defer cancel()

			rows[i] = s.agent.Redeploy(hostCtx, host, gameID)
		}()
	}
	asking.Wait()

	for _, row := range rows {
		if row.Status == contract.DeployFailed {
			// The one thing this fan-out learns that no beat carries: a box that did not answer.
			// Marked here rather than waited for, because the staleness window is the slow path to
			// the same conclusion and this box just refused work in front of us.
			s.registry.Suspect(row.HostID, "redeploy unanswered", s.now())
			continue
		}
		if row.Status != contract.DeployDraining {
			continue
		}
		// Recorded from the answer rather than waited for: the next beat from that box is the
		// authority and overwrites this, but it is a whole heartbeat away, and every joiner placed
		// in between would be sent into a world that is already ending.
		s.registry.Draining(row.HostID, row.InstanceIDs)
	}
	return rows
}

func checkDeployment(req contract.DeploymentRequest) (string, bool) {
	if !contract.ValidUUID(req.GameID) {
		return "gameId must be a uuid", false
	}
	if problem, ok := checkBundleSet(req.Bundles); !ok {
		return problem, false
	}
	for _, region := range req.Regions {
		if region == "" || len(region) > contract.RegionMaxLen {
			return "every region must be set and at most 32 characters", false
		}
	}
	return "", true
}

// checkBundleSet holds a set to everything a box will need of it. One validator for both routes:
// a placement and a deployment hand the same set to the same agent, so a set one route passed and
// the other refused would fail at the box instead of at the edge.
func checkBundleSet(set contract.BundleSet) (string, bool) {
	if problem, ok := checkBundle(set.Server, contract.SideServer); !ok {
		return problem, false
	}
	if problem, ok := checkBundle(set.Client, contract.SideClient); !ok {
		return problem, false
	}
	if !contract.ValidContentHash(set.SimConfig.Hash) {
		return "bundles.simConfig.hash must be a content hash", false
	}
	if !contract.ValidURL(set.SimConfig.URL) {
		return "bundles.simConfig.url must be a url", false
	}
	if set.SimConfig.ByteLength <= 0 {
		return "bundles.simConfig.byteLength must be positive", false
	}
	// The hash both halves were built from. A session compares it at the handshake, so a set whose
	// two halves came from different sources must not reach a box at all.
	if !contract.ValidContentHash(set.SyncedHash) {
		return "bundles.syncedHash must be a content hash", false
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

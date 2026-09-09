// The registry's two routes: what a box reports, and what the fleet looks like from here.

package api

import (
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// heartbeat upserts one box. 204, because the sender has nothing to read and beats every few seconds.
func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	hostID := r.PathValue("hostId")
	if !contract.ValidUUID(hostID) {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, "hostId must be a uuid")
		return
	}

	var beat contract.HostHeartbeat
	if !httpx.DecodeJSON(w, r, &beat, maxBodyBytes) {
		return
	}
	if problem, ok := checkHeartbeat(beat, hostID); !ok {
		httpx.WriteError(w, http.StatusBadRequest, httpx.CodeInvalidRequest, problem)
		return
	}

	s.registry.Beat(beat, remoteIP(r), s.now())
	w.WriteHeader(http.StatusNoContent)
}

// listHosts answers with the whole fleet, stale boxes included: a box that is down is a fact an
// operator needs, and hiding it would read as a box that was never provisioned.
func (s *Server) listHosts(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, s.registry.Views(s.now()))
}

func checkHeartbeat(beat contract.HostHeartbeat, hostID string) (string, bool) {
	if beat.HostID != hostID {
		return "hostId in the path and the body must match", false
	}
	if beat.Region == "" || len(beat.Region) > contract.RegionMaxLen {
		return "region must be set and at most 32 characters", false
	}
	// The bounds HostCapacity carries in libs/api-contract, enforced here because whatever this
	// stores is re-served verbatim as a HostView — a beat this accepted but that schema rejects is
	// a box only the Go half can read.
	if beat.Capacity.MaxInstances <= 0 || beat.Capacity.RunningInstances < 0 {
		return "maxInstances must be positive and runningInstances must not be negative", false
	}
	if beat.Capacity.CPULoad < 0 || beat.Capacity.CPULoad > 1 {
		return "cpuLoad must be between 0 and 1", false
	}
	if beat.Capacity.MemoryFreeBytes < 0 {
		return "memoryFreeBytes must not be negative", false
	}
	// Parsed but not kept: a box with a skewed clock must not be able to claim it is fresh, so
	// `lastSeenAt` is when this service heard the beat.
	if _, err := contract.ParseTimestamp(beat.ReportedAt); err != nil {
		return "reportedAt must be an rfc3339 timestamp", false
	}

	for _, inst := range beat.Instances {
		if !contract.ValidUUID(inst.InstanceID) || !contract.ValidUUID(inst.GameID) ||
			!contract.ValidUUID(inst.SessionID) {
			return "every instance must carry uuid ids", false
		}
		if !inst.State.Valid() {
			return "instance state must be starting, healthy, draining or unhealthy", false
		}
		if inst.Players < 0 || inst.UptimeSeconds < 0 {
			return "instance players and uptimeSeconds must not be negative", false
		}
	}
	return "", true
}

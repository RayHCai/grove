// The fleet as this process holds it: one map behind one mutex, which is where a datastore lands.

package fleet

import (
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Registry is every box that has ever beaten in.
//
// A stale host is kept rather than dropped: a box that comes back from a network partition should
// resume taking work, not be re-provisioned as if it had never existed.
type Registry struct {
	mu         sync.RWMutex
	staleAfter time.Duration
	hosts      map[string]Host
}

func NewRegistry(staleAfter time.Duration) *Registry {
	return &Registry{staleAfter: staleAfter, hosts: make(map[string]Host)}
}

// Beat records what one box reported, from the address it reported over.
func (reg *Registry) Beat(hb contract.HostHeartbeat, addr string, at time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	reg.hosts[hb.HostID] = Host{
		ID:       hb.HostID,
		Region:   hb.Region,
		Capacity: hb.Capacity,
		// Cloned so the decoded body a handler is about to drop cannot alias registry state.
		Instances:  slices.Clone(hb.Instances),
		Addr:       addr,
		LastSeenAt: at,
	}
}

// Views is the whole fleet, healthy or not, ordered by host so two reads agree.
func (reg *Registry) Views(now time.Time) []contract.HostView {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	views := make([]contract.HostView, 0, len(reg.hosts))
	for _, h := range reg.hosts {
		views = append(views, h.View(now, reg.staleAfter))
	}
	slices.SortFunc(views, func(a, b contract.HostView) int {
		return strings.Compare(a.HostID, b.HostID)
	})
	return views
}

// Candidates is every box that could take another session right now.
//
// A named region is a hard filter, not a preference: a caller asks for one to bound latency, and
// honouring it only when it is convenient makes that latency unpredictable.
func (reg *Registry) Candidates(region string, now time.Time) []Host {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	candidates := make([]Host, 0, len(reg.hosts))
	for _, h := range reg.hosts {
		if !h.Fresh(now, reg.staleAfter) || h.FreeSlots() == 0 {
			continue
		}
		if region != "" && h.Region != region {
			continue
		}
		candidates = append(candidates, h)
	}
	return candidates
}

// Serving finds the box already running a healthy session of the game, which a joining player joins.
//
// Deliberately not filtered on free slots the way Candidates is: joining a world that is already
// running starts no process, so a box at its instance cap can still take the player.
func (reg *Registry) Serving(gameID, region string, now time.Time) (Host, contract.InstanceReport, bool) {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	var best Host
	var report contract.InstanceReport
	found := false

	for _, h := range reg.hosts {
		if !h.Fresh(now, reg.staleAfter) {
			continue
		}
		if region != "" && h.Region != region {
			continue
		}
		inst, serving := h.Serving(gameID)
		if !serving {
			continue
		}
		// The lowest hostId wins, never map order: two players joining at once must be told the
		// same box, or one game's world splits in two on a coin flip.
		if !found || h.ID < best.ID {
			best, report, found = h, inst, true
		}
	}
	return best, report, found
}

// Deploy names the healthy boxes in the requested regions, which are the ones a version goes out to.
//
// It gates nothing downstream: a box pulls the bundle set by hash when it spawns a process, so a
// placement on a box that has not pulled yet is a cold start rather than a failure.
func (reg *Registry) Deploy(req contract.DeploymentRequest, at time.Time) contract.Deployment {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	hosts := make([]string, 0, len(reg.hosts))
	for _, h := range reg.hosts {
		if !h.Fresh(at, reg.staleAfter) {
			continue
		}
		if len(req.Regions) > 0 && !slices.Contains(req.Regions, h.Region) {
			continue
		}
		hosts = append(hosts, h.ID)
	}
	slices.Sort(hosts)

	return contract.Deployment{
		GameID:     req.GameID,
		Bundles:    req.Bundles,
		Hosts:      hosts,
		DeployedAt: contract.Timestamp(at),
	}
}

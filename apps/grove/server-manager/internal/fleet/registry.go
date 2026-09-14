// The fleet as this process holds it: one map behind one mutex, which is where a datastore lands.

package fleet

import (
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// RetainWindows is how many staleness windows a box may be gone before its row is dropped — an hour
// at the default, which is longer than any reboot and short enough that the map stops growing.
const RetainWindows = 120

// Registry is every box that has beaten in, less the ones gone longer than RetainWindows.
//
// A stale host is kept rather than dropped: a box that comes back from a network partition should
// resume taking work, not be re-provisioned as if it had never existed.
type Registry struct {
	mu         sync.RWMutex
	staleAfter time.Duration
	retain     time.Duration
	hosts      map[string]Host
	// What has been placed and not yet beaten back, keyed by game: a slot it spent is spent, and
	// the next player of that game joins it rather than starting a second world.
	pending map[string]reservation
}

// reservation is one session this service handed out, on the box it was handed out for.
type reservation struct {
	hostID     string
	instanceID string
	sessionID  string
	// Filled from the first beat that names the session: the kernel on the box picks the port at
	// spawn, so nothing here can know it before the box has one to report.
	port int
	// Set once the box's own beat counts the session, after which holding its slot here as well
	// would spend that slot twice and report the box full at half its capacity.
	reported bool
}

// Placement is the box one join landed on and the ids it carries, before an Ingress names a URL.
type Placement struct {
	Host       Host
	InstanceID string
	SessionID  string
	// The port the box bound for this session, which is the one a player dials. Zero until the box
	// has reported the process, because the kernel picks it at spawn.
	Port int
}

func NewRegistry(staleAfter time.Duration) *Registry {
	// Floored because a window long enough to overflow the multiply would leave a negative retain,
	// which drops every row on the beat that just wrote one.
	retain := RetainWindows * staleAfter
	if retain < staleAfter {
		retain = staleAfter
	}

	return &Registry{
		staleAfter: staleAfter,
		retain:     retain,
		hosts:      make(map[string]Host),
		pending:    make(map[string]reservation),
	}
}

// Beat records what one box reported, from the address it reported over.
func (reg *Registry) Beat(hb contract.HostHeartbeat, addr string, at time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	reg.hosts[hb.HostID] = Host{
		ID:        hb.HostID,
		Region:    hb.Region,
		AgentPort: hb.AgentPort,
		Capacity:  hb.Capacity,
		// Cloned so the decoded body a handler is about to drop cannot alias registry state.
		Instances:  slices.Clone(hb.Instances),
		Addr:       addr,
		LastSeenAt: at,
	}
	reg.evict(at)
	reg.settle(hb)
}

// evict drops a box gone far past the staleness window, which no operator can act on any more and
// which re-registers itself on its next beat if it ever does come back.
func (reg *Registry) evict(at time.Time) {
	for id, h := range reg.hosts {
		if at.Sub(h.LastSeenAt) > reg.retain {
			delete(reg.hosts, id)
		}
	}
}

// settle answers the placements this beat accounts for: a box that does not report a session it was
// handed never took it, so the next player to join that game ranks again rather than being sent
// after a process nothing started, and one it does report is the box's own capacity to count.
func (reg *Registry) settle(hb contract.HostHeartbeat) {
	for gameID, res := range reg.pending {
		if _, known := reg.hosts[res.hostID]; !known {
			delete(reg.pending, gameID)
			continue
		}
		if res.hostID != hb.HostID {
			continue
		}
		port, taken := portOf(hb.Instances, res.sessionID)
		if !taken {
			delete(reg.pending, gameID)
			continue
		}
		// Kept rather than dropped, so two players joining a game the box is still starting are
		// still handed one session — but no longer counted against the slot the box now counts.
		res.reported = true
		res.port = port
		reg.pending[gameID] = res
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

	reserved := reg.reservedByHost()
	candidates := make([]Host, 0, len(reg.hosts))
	for _, h := range reg.hosts {
		h.Reserved = reserved[h.ID]
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

// Place answers one join: the box it lands on, and the ids the player carries there.
//
// ordered is where the balancer would start the game, best box first, read only when nothing
// already holds it. The whole decision is one critical section because two joins that each mint a
// session between two beats are two worlds for one game.
func (reg *Registry) Place(req contract.PlacementRequest, ordered []Host, at time.Time) (Placement, bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	// A box already running the game wins over an emptier one, and the ranking never gets a say: a
	// game is a world its players share, and MostFree would send the second player to the box with
	// the most free slots — which is never the box already spending one on this game.
	if running, ok := reg.serving(req.GameID, req.Region, at); ok {
		return running, true
	}
	if held, ok := reg.held(req.GameID, req.Region, at); ok {
		return held, true
	}

	// Re-read rather than trust the copies the balancer ranked, which it was handed before this
	// lock, and fall down the order: a box that filled in between costs this join its first choice
	// and not the whole fleet, so a 409 means every qualifying box filled.
	for _, ranked := range ordered {
		host, free := reg.placeable(ranked.ID, req.Region, at)
		if !free {
			continue
		}

		placed := Placement{Host: host, InstanceID: contract.NewUUID(), SessionID: contract.NewUUID()}
		reg.pending[req.GameID] = reservation{
			hostID:     host.ID,
			instanceID: placed.InstanceID,
			sessionID:  placed.SessionID,
		}
		return placed, true
	}
	return Placement{}, false
}

// serving finds the box already running a healthy session of the game, which a joining player joins.
//
// Deliberately not filtered on free slots the way Candidates is: joining a world that is already
// running starts no process, so a box at its instance cap can still take the player.
func (reg *Registry) serving(gameID, region string, now time.Time) (Placement, bool) {
	var best Placement
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
		if !found || h.ID < best.Host.ID {
			best = Placement{
				Host:       h,
				InstanceID: inst.InstanceID,
				SessionID:  inst.SessionID,
				Port:       inst.Port,
			}
			found = true
		}
	}
	return best, found
}

// held is the placement this game was already given, while the box that took it has yet to beat.
func (reg *Registry) held(gameID, region string, now time.Time) (Placement, bool) {
	res, ok := reg.pending[gameID]
	if !ok {
		return Placement{}, false
	}
	h, known := reg.hosts[res.hostID]
	if !known || !h.Fresh(now, reg.staleAfter) {
		return Placement{}, false
	}
	// The same hard region filter a running session is joined under, so a caller that named one is
	// never sent out of it by a placement it cannot see.
	if region != "" && h.Region != region {
		return Placement{}, false
	}
	// Refused where settle still counts the work as taken, because every later joiner for the game
	// would otherwise be routed into that one world until the box stops naming it.
	if ailing(h.Instances, res.sessionID) {
		return Placement{}, false
	}
	return Placement{
		Host:       h,
		InstanceID: res.instanceID,
		SessionID:  res.sessionID,
		Port:       res.port,
	}, true
}

// placeable re-reads a box the balancer ranked, and reports whether it will still take a session.
func (reg *Registry) placeable(hostID, region string, now time.Time) (Host, bool) {
	h, known := reg.hosts[hostID]
	if !known || !h.Fresh(now, reg.staleAfter) {
		return Host{}, false
	}
	// Re-checked here like freshness, because a beat since the ranking rewrites the whole row, and
	// a named region is the one thing a placement may never bend.
	if region != "" && h.Region != region {
		return Host{}, false
	}
	h.Reserved = reg.reservedOn(hostID)
	return h, h.FreeSlots() > 0
}

// reservedOn counts the sessions placed on one box that its own beats have yet to account for.
func (reg *Registry) reservedOn(hostID string) int {
	reserved := 0
	for _, res := range reg.pending {
		if res.hostID == hostID && !res.reported {
			reserved++
		}
	}
	return reserved
}

// reservedByHost counts the same per box, for a caller weighing the whole fleet at once.
func (reg *Registry) reservedByHost() map[string]int {
	byHost := make(map[string]int, len(reg.pending))
	for _, res := range reg.pending {
		if res.reported {
			continue
		}
		byHost[res.hostID]++
	}
	return byHost
}

// portOf says whether the beat accounts for the session in any state — a box still starting the
// process has not dropped the work — and on what port it bound it.
func portOf(instances []contract.InstanceReport, sessionID string) (int, bool) {
	for _, inst := range instances {
		if inst.SessionID == sessionID {
			return inst.Port, true
		}
	}
	return 0, false
}

// ailing says whether the beat names the session draining or unhealthy, which is a world shutting
// down or already sick and no place to send the next joiner.
func ailing(instances []contract.InstanceReport, sessionID string) bool {
	return slices.ContainsFunc(instances, func(inst contract.InstanceReport) bool {
		return inst.SessionID == sessionID &&
			(inst.State == contract.InstanceDraining || inst.State == contract.InstanceUnhealthy)
	})
}

// Deploy names the healthy boxes in the requested regions, which are the ones a version goes out to.
//
// It names them and nothing else: what a box runs is decided at start, from the paths its start
// request carries, so this answer gates no placement that follows it.
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

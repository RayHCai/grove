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
	// What has been placed and not yet beaten back: a slot it spent is spent, so the next player of
	// that world joins it. Keyed by version as well as game, because a rollout leaves the two side by
	// side and a game-only key would hand a new-version joiner the session minted for the old one.
	pending map[world]reservation
	// Transitions nobody has reported onward yet, oldest first. See events.go.
	events []contract.FleetEvent
}

// world is one game on one version, which is the unit a session is shared within.
type world struct {
	gameID   string
	revision int
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
	// The version the world this join landed in is running. The one asked for on every path but a
	// reservation the caller has yet to start, where it is the version it is about to be started on.
	Revision int
	// The port the box bound for this session, which is the one a player dials. Zero until the box
	// has reported the process, because the kernel picks it at spawn.
	Port int
	// Whether this join reserved a world nothing is running yet, which its caller must now ask the
	// box to start. False for a session already serving and for one an earlier join reserved: a
	// second start of one session would be a second world half the players are talking to.
	Starts bool
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
		pending:    make(map[world]reservation),
	}
}

// Beat records what one box reported, from the address it reported over.
func (reg *Registry) Beat(hb contract.HostHeartbeat, addr string, at time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	previous, known := reg.hosts[hb.HostID]

	h := Host{
		ID:        hb.HostID,
		Region:    hb.Region,
		AgentPort: hb.AgentPort,
		Capacity:  hb.Capacity,
		// Cloned so the decoded body a handler is about to drop cannot alias registry state.
		Instances:   slices.Clone(hb.Instances),
		Addr:        addr,
		LastSeenAt:  at,
		Incarnation: hb.Incarnation,
		Leaving:     hb.Leaving,
		// Suspicion is deliberately absent: this beat is the box answering, which is the evidence
		// that outranks whatever failed against it.
		Reported: previous.Reported,
	}

	switch {
	case !known:
		h.Reported = h.Liveness(at, reg.staleAfter)
		reg.note(h, contract.FleetRegistered, at, "")
	case previous.Incarnation != hb.Incarnation:
		// Recorded as its own kind rather than as a return, because the worlds the previous life
		// was running went with it — a box back inside the staleness window never looked absent.
		h.Reported = h.Liveness(at, reg.staleAfter)
		reg.note(h, contract.FleetRestarted, at, "")
	default:
		h = reg.observe(h, at, "")
	}

	reg.hosts[hb.HostID] = h
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
	for key, res := range reg.pending {
		if _, known := reg.hosts[res.hostID]; !known {
			delete(reg.pending, key)
			continue
		}
		if res.hostID != hb.HostID {
			continue
		}
		port, taken := portOf(hb.Instances, res.sessionID)
		if !taken {
			delete(reg.pending, key)
			continue
		}
		// Kept rather than dropped, so two players joining a game the box is still starting are
		// still handed one session — but no longer counted against the slot the box now counts.
		res.reported = true
		res.port = port
		reg.pending[key] = res
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
		if !h.Placeable(now, reg.staleAfter) || h.FreeSlots() == 0 {
			continue
		}
		if region != "" && h.Region != region {
			continue
		}
		candidates = append(candidates, h)
	}
	return candidates
}

// Place answers one join: the box it lands on, and the ids the player carries there. `ordered` is
// where the balancer would start the game, read only when nothing already holds it. The whole
// decision is one critical section, or two joins between beats become two worlds for one game.
func (reg *Registry) Place(req contract.PlacementRequest, ordered []Host, at time.Time) (Placement, bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	key := world{gameID: req.GameID, revision: req.Revision}

	// A box already running this world wins over an emptier one, and the ranking never gets a say:
	// a world is one its players share, and MostFree would send the second player to the box with
	// the most free slots — which is never the box already spending one on this game.
	if running, ok := reg.serving(key, req.Region, at); ok {
		return running, true
	}
	if held, ok := reg.held(key, req.Region, at); ok {
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

		placed := Placement{
			Host:       host,
			InstanceID: contract.NewUUID(),
			SessionID:  contract.NewUUID(),
			Revision:   req.Revision,
			// Nothing is running this world anywhere the caller may reach, so the caller owes the
			// chosen box a start. Committed under this lock so a second join arriving behind it
			// finds the reservation and waits on one process rather than starting another.
			Starts: true,
		}
		reg.pending[key] = reservation{
			hostID:     host.ID,
			instanceID: placed.InstanceID,
			sessionID:  placed.SessionID,
		}
		return placed, true
	}
	return Placement{}, false
}

// Started records the port a box bound for a session this service asked it to start.
//
// Written rather than waited for: the port is in the box's answer, and a placement handed out with
// a zero port is an address no player can dial for the whole heartbeat it would take to learn one.
func (reg *Registry) Started(gameID string, revision int, sessionID string, port int) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	key := world{gameID: gameID, revision: revision}
	if res, ok := reg.pending[key]; ok && res.sessionID == sessionID {
		res.port = port
		reg.pending[key] = res
	}
}

// serving finds the box already running a healthy session of the game, which a joiner joins.
// Deliberately not filtered on free slots the way Candidates is: joining a running world starts
// no process, so a box at its instance cap can still take the player.
func (reg *Registry) serving(key world, region string, now time.Time) (Placement, bool) {
	var best Placement
	found := false

	for _, h := range reg.hosts {
		if !h.Placeable(now, reg.staleAfter) {
			continue
		}
		if region != "" && h.Region != region {
			continue
		}
		inst, serving := h.Serving(key.gameID, key.revision)
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
				Revision:   inst.Revision,
				Port:       inst.Port,
			}
			found = true
		}
	}
	return best, found
}

// held is the placement this world was already given, while the box that took it has yet to beat.
func (reg *Registry) held(key world, region string, now time.Time) (Placement, bool) {
	res, ok := reg.pending[key]
	if !ok {
		return Placement{}, false
	}
	h, known := reg.hosts[res.hostID]
	if !known || !h.Placeable(now, reg.staleAfter) {
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
		Revision:   key.revision,
		Port:       res.port,
	}, true
}

// placeable re-reads a box the balancer ranked, and reports whether it will still take a session.
func (reg *Registry) placeable(hostID, region string, now time.Time) (Host, bool) {
	h, known := reg.hosts[hostID]
	if !known || !h.Placeable(now, reg.staleAfter) {
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

// Targets is every box a version must reach: the fresh ones in the requested regions holding a
// world of the game, ordered by hostId so two identical pushes agree. The reservation counts
// alongside reported instances, or a box handed a placement seconds ago keeps the old code.
func (reg *Registry) Targets(req contract.DeploymentRequest, at time.Time) []Host {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	// Every version of the game, not one: a rollout ends the worlds a game has anywhere, and a
	// reservation on an older revision is a box about to start code this push supersedes.
	reserving := make(map[string]bool, len(reg.pending))
	for key, res := range reg.pending {
		if key.gameID == req.GameID {
			reserving[res.hostID] = true
		}
	}

	targets := make([]Host, 0, len(reg.hosts))
	for _, h := range reg.hosts {
		// Freshness rather than placeability, which is the narrower question: a suspected box still
		// holds worlds a version has to reach, and the attempt is what settles the suspicion either
		// way. A box that said it was leaving is the one exception — its worlds are already ending.
		if !h.Fresh(at, reg.staleAfter) || h.Leaving {
			continue
		}
		if len(req.Regions) > 0 && !slices.Contains(req.Regions, h.Region) {
			continue
		}
		if len(h.Holds(req.GameID)) == 0 && !reserving[h.ID] {
			continue
		}
		targets = append(targets, h)
	}
	slices.SortFunc(targets, func(a, b Host) int { return strings.Compare(a.ID, b.ID) })
	return targets
}

// Draining records what a box just answered a redeploy with, so the router stops sending joiners
// into a world that is ending. Written here rather than waited for: the next beat overwrites it,
// but every joiner placed in between would meet a process already refusing upgrades.
func (reg *Registry) Draining(hostID string, instanceIDs []string) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	h, known := reg.hosts[hostID]
	if !known {
		return
	}

	// The row is replaced rather than edited where it lies, the way a beat replaces one: Candidates
	// hands out hosts whose instance slices alias what is stored here, and a write into that array
	// would reach a ranking already running outside this lock.
	instances := slices.Clone(h.Instances)
	for i, inst := range instances {
		if slices.Contains(instanceIDs, inst.InstanceID) {
			instances[i].State = contract.InstanceDraining
		}
	}
	h.Instances = instances
	reg.hosts[hostID] = h
}

// Release hands back the slot a placement held, for a join whose caller is already gone.
// Guarded on the session rather than the world: a reservation minted for a later joiner must
// survive an earlier one giving up, or an abandoned join sends the next player nowhere.
func (reg *Registry) Release(gameID, sessionID string) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	for key, res := range reg.pending {
		if key.gameID == gameID && res.sessionID == sessionID {
			delete(reg.pending, key)
			return
		}
	}
}

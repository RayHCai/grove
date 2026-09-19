// Package fleet is the registry of boxes this service routes over, and the policy that chooses one.
package fleet

import (
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// Host is one EC2 box as the last heartbeat left it, and what this service placed on it since.
type Host struct {
	ID     string
	Region string
	// Where this box's agent listens, as the box itself reported it, so nothing here is compiled in.
	AgentPort int
	Capacity  contract.HostCapacity
	// Every instance the box reported, not a delta: a dropped beat costs nothing to recover from.
	Instances []contract.InstanceReport
	// Where the beat came from. Taken from the connection rather than a field, because a box that
	// named its own address could point joining players at another one.
	Addr string
	// When this service heard the beat, never when the box says it sent one — a skewed clock on one
	// box must not make it look healthy here.
	LastSeenAt time.Time
	// Sessions placed here that the Capacity above cannot have counted yet, filled in when the box
	// is offered as a candidate so that filtering and ranking read the same number of free slots.
	Reserved int
	// Fixed for the life of the box's agent. A change is the box having restarted, which HostID
	// cannot show because it survives a reboot on purpose.
	Incarnation string
	// Set by the box's own last beat. Silence is how this service finds a crash, so without this a
	// deploy and a crash are the same event.
	Leaving bool
	// Set when work this service dispatched failed against the box, and cleared by its next beat.
	// Evidence that arrives sooner than the staleness window, and never later than it.
	Suspected bool
	// The liveness an event was last emitted for, so a box sitting failed produces one row rather
	// than one per sweep.
	Reported contract.HostLiveness
}

// Liveness is what this service concludes about the box, never what the box claimed.
// The box's own last word outranks silence: one that said it was leaving stays `left` however
// long ago, or every deploy ages into a failure an hour later.
func (h Host) Liveness(now time.Time, staleAfter time.Duration) contract.HostLiveness {
	switch {
	case h.Leaving:
		return contract.HostLeft
	case !h.Fresh(now, staleAfter):
		return contract.HostFailed
	case h.Suspected:
		return contract.HostSuspected
	default:
		return contract.HostHealthy
	}
}

// Placeable reports whether a joining player may be sent here, which is the one liveness that earns
// work: suspected and left are both boxes this service already has a reason to route around.
func (h Host) Placeable(now time.Time, staleAfter time.Duration) bool {
	return h.Liveness(now, staleAfter) == contract.HostHealthy
}

// FreeSlots is how many more game processes the box will take.
func (h Host) FreeSlots() int {
	free := h.Capacity.MaxInstances - h.Capacity.RunningInstances - h.Reserved
	if free < 0 {
		return 0
	}
	return free
}

// Holds names every world of the game on this box, whatever state it is in. Wider than Serving
// deliberately: a new version has to reach the sick ones too, and filtering on health would
// leave a wedged process running the old code.
func (h Host) Holds(gameID string) []string {
	ids := make([]string, 0, len(h.Instances))
	for _, inst := range h.Instances {
		if inst.GameID == gameID {
			ids = append(ids, inst.InstanceID)
		}
	}
	return ids
}

// Serving finds a live session of the game on this box a joining player may join. The revision
// is part of the question, not a preference: a world draining on the previous version runs code
// the joiner has not fetched, and the handshake there refuses it.
func (h Host) Serving(gameID string, revision int) (contract.InstanceReport, bool) {
	for _, inst := range h.Instances {
		if inst.GameID == gameID && inst.Revision == revision &&
			inst.State == contract.InstanceHealthy {
			return inst, true
		}
	}
	return contract.InstanceReport{}, false
}

// View renders the row `GET /v1/hosts` answers with.
func (h Host) View(now time.Time, staleAfter time.Duration) contract.HostView {
	return contract.HostView{
		HostID:      h.ID,
		Region:      h.Region,
		Capacity:    h.Capacity,
		LastSeenAt:  contract.Timestamp(h.LastSeenAt),
		Liveness:    h.Liveness(now, staleAfter),
		Incarnation: h.Incarnation,
	}
}

// Fresh reports whether the box has been heard from recently enough to be given work.
func (h Host) Fresh(now time.Time, staleAfter time.Duration) bool {
	return now.Sub(h.LastSeenAt) < staleAfter
}

// Ingress answers where a browser dials for a placement.
//
// A seam because reachability is a topology fact this service does not hold: a real fleet fronts a
// box with a regional edge or a DNS name, where a single-region one is dialled at its address.
type Ingress interface {
	URL(h Host, p Placement) string
}

// DirectIngress dials the session's own process, which is the socket a player speaks the game over.
//
// Scheme is a deliberate choice rather than a topology this service can read, so the zero value is
// the secure spelling and a cleartext fleet has to be asked for by name.
type DirectIngress struct{ Scheme string }

// URL names the port the box bound for this session, never the agent's: the agent answers JSON
// behind the fleet bearer, and the kernel picks the game's port afresh for every process.
func (d DirectIngress) URL(h Host, p Placement) string {
	return fmt.Sprintf("%s://%s/play", d.scheme(), net.JoinHostPort(h.Addr, strconv.Itoa(p.Port)))
}

func (d DirectIngress) scheme() string {
	if d.Scheme == "" {
		return "wss"
	}
	return d.Scheme
}

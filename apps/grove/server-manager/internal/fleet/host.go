// Package fleet is the registry of boxes this service routes over, and the policy that chooses one.
package fleet

import (
	"net"
	"strconv"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// JoinGrace is how many staleness windows a box's running worlds stay joinable for after it went
// quiet or said goodbye: long enough for its agent to restart, short enough for a dead box.
const JoinGrace = 2

// Host is one EC2 box as the last heartbeat left it, and what this service placed on it since.
type Host struct {
	ID     string
	Region string
	// Where this box's agent listens, as the box itself reported it, so nothing here is compiled in.
	AgentPort int
	// The name the box is reached by and the port its player proxy listens on, as it reported them.
	PublicHost string
	PlayerPort int
	// Whether the box serves TLS, which picks every scheme a url to it is spelled with.
	TLS bool
	// The box's own word that a start could succeed there now.
	Ready    bool
	Capacity contract.HostCapacity
	// Every instance the box reported, not a delta: a dropped beat costs nothing to recover from.
	Instances []contract.InstanceReport
	// Where the beat came from, used only when the box named no PublicHost, which a production
	// beat must: behind a proxy, the source address of every box is the proxy's.
	Addr string
	// When this service heard the beat, never when the box says it sent one; a skewed clock on one
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
	// Until when work this service dispatched there failed recently enough to route around it; a
	// beat does not clear it, since a box that cannot start a world still beats.
	SuspectedUntil time.Time
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
	case now.Before(h.SuspectedUntil):
		return contract.HostSuspected
	default:
		return contract.HostHealthy
	}
}

// Placeable reports whether a new world may start here: healthy, and ready by its own account.
func (h Host) Placeable(now time.Time, staleAfter time.Duration) bool {
	return h.Ready && h.Liveness(now, staleAfter) == contract.HostHealthy
}

// Joinable reports whether a player may still join a world already running here. Wider than
// Placeable: a farewell, a suspicion or a missed beat says nothing about the worlds the box holds.
func (h Host) Joinable(now time.Time, staleAfter time.Duration) bool {
	return now.Sub(h.LastSeenAt) < JoinGrace*staleAfter
}

// FreeSlots is how many more game processes the box will take.
func (h Host) FreeSlots() int {
	free := h.Capacity.MaxInstances - h.Capacity.RunningInstances - h.Reserved
	if free < 0 {
		return 0
	}
	return free
}

// Superseded names every world of the game on this box not on revision, whatever state it is in:
// a new version has to reach the sick ones too, and the worlds already on it are what it wants.
func (h Host) Superseded(gameID string, revision int) []string {
	ids := make([]string, 0, len(h.Instances))
	for _, inst := range h.Instances {
		if inst.GameID == gameID && inst.Revision != revision {
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

// Dial is the name every url to this box is built on.
func (h Host) Dial() string {
	if h.PublicHost != "" {
		return h.PublicHost
	}
	return h.Addr
}

// Ingress answers where a browser dials for a placement.
//
// A seam because reachability is a topology fact: a real fleet could front its boxes with a
// regional edge, where one region is dialled at each box's own player proxy.
type Ingress interface {
	URL(h Host, p Placement) string
}

// ProxyIngress dials the box's player proxy, which carries the socket to the world on loopback.
type ProxyIngress struct{}

// URL names the world by its instance on the box's public listener, never a child's own port: no
// child faces out, and the proxy is the one door it can be reached through.
func (ProxyIngress) URL(h Host, p Placement) string {
	scheme := "ws"
	if h.TLS {
		scheme = "wss"
	}
	return scheme + "://" + net.JoinHostPort(h.Dial(), strconv.Itoa(h.PlayerPort)) + "/play/" + p.InstanceID
}

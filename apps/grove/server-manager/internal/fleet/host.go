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
}

// FreeSlots is how many more game processes the box will take.
func (h Host) FreeSlots() int {
	free := h.Capacity.MaxInstances - h.Capacity.RunningInstances - h.Reserved
	if free < 0 {
		return 0
	}
	return free
}

// Serving finds a live session of the game already on this box, which a joining player joins.
func (h Host) Serving(gameID string) (contract.InstanceReport, bool) {
	for _, inst := range h.Instances {
		if inst.GameID == gameID && inst.State == contract.InstanceHealthy {
			return inst, true
		}
	}
	return contract.InstanceReport{}, false
}

// View renders the row `GET /v1/hosts` answers with.
func (h Host) View(now time.Time, staleAfter time.Duration) contract.HostView {
	return contract.HostView{
		HostID:     h.ID,
		Region:     h.Region,
		Capacity:   h.Capacity,
		LastSeenAt: contract.Timestamp(h.LastSeenAt),
		Healthy:    h.Fresh(now, staleAfter),
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

// Package fleet is the registry of boxes this service routes over, and the policy that chooses one.
package fleet

import (
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// The port @grove/instance-manager listens on across the fleet. A game process binds an ephemeral
// port, so the agent on the box is what resolves a placement to whatever port it actually got.
const instanceManagerPort = 4004

// Host is one EC2 box as the last heartbeat left it.
type Host struct {
	ID       string
	Region   string
	Capacity contract.HostCapacity
	// Every instance the box reported, not a delta: a dropped beat costs nothing to recover from.
	Instances []contract.InstanceReport
	// Where the beat came from. Taken from the connection rather than a field, because a box that
	// named its own address could point joining players at another one.
	Addr string
	// When this service heard the beat, never when the box says it sent one — a skewed clock on one
	// box must not make it look healthy here.
	LastSeenAt time.Time
}

// FreeSlots is how many more game processes the box will take.
func (h Host) FreeSlots() int {
	free := h.Capacity.MaxInstances - h.Capacity.RunningInstances
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
	URL(h Host, instanceID string) string
}

// DirectIngress dials the box itself, at the agent that supervises the session's process.
type DirectIngress struct{}

func (DirectIngress) URL(h Host, instanceID string) string {
	return fmt.Sprintf("wss://%s/v1/instances/%s",
		net.JoinHostPort(h.Addr, strconv.Itoa(instanceManagerPort)), instanceID)
}

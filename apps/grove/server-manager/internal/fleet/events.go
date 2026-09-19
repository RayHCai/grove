// The history half of the registry: what a box did, as opposed to what it is.
//
// The registry answers what the fleet is right now, and one beat replaces the whole of it — which
// means the state a box was in is on no beat at all. A transition is therefore the only thing about
// a box worth keeping, and this is where the ones nobody has taken yet are held.

package fleet

import (
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// MaxPendingEvents bounds what one unreachable reporter can cost this process.
//
// Dropping the oldest rather than refusing the newest: a receiver that has been down long enough to
// overflow this needs what the fleet did lately far more than what it did first.
const MaxPendingEvents = 1024

// kindFor names the transition into a liveness. Read off the destination alone, because the row is
// about what the box became — where it came from is the row before it.
func kindFor(to contract.HostLiveness) contract.FleetEventKind {
	switch to {
	case contract.HostSuspected:
		return contract.FleetSuspected
	case contract.HostLeft:
		return contract.FleetLeft
	case contract.HostFailed:
		return contract.FleetFailed
	default:
		return contract.FleetReturned
	}
}

// note appends one transition. Callers hold the write lock.
func (reg *Registry) note(h Host, kind contract.FleetEventKind, at time.Time, detail string) {
	reg.events = append(reg.events, contract.FleetEvent{
		EventID:     contract.NewUUID(),
		HostID:      h.ID,
		Region:      h.Region,
		Kind:        kind,
		Incarnation: h.Incarnation,
		At:          contract.Timestamp(at),
		Detail:      detail,
	})

	if len(reg.events) > MaxPendingEvents {
		reg.events = reg.events[len(reg.events)-MaxPendingEvents:]
	}
}

// observe records the box's liveness having changed, and answers the host with the new one recorded.
//
// Compared against the liveness an event last went out for rather than against the previous beat's,
// so a box that has been failed for an hour produces the one row that says so and not one per sweep.
// Callers hold the write lock.
func (reg *Registry) observe(h Host, at time.Time, detail string) Host {
	current := h.Liveness(at, reg.staleAfter)
	if current == h.Reported {
		return h
	}

	h.Reported = current
	reg.note(h, kindFor(current), at, detail)
	return h
}

// Drain takes every transition recorded since the last call.
//
// Taken rather than read: the caller that has them is the one reporting them onward, and a second
// reader would either duplicate its rows or race it for them.
func (reg *Registry) Drain() []contract.FleetEvent {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	if len(reg.events) == 0 {
		return nil
	}
	taken := reg.events
	reg.events = nil
	return taken
}

// Restore puts events back after a failed report, oldest first.
//
// The alternative is losing the transition, and a history with a hole in it is worse than one that
// arrives late — a box that failed and never came back is exactly the row an operator goes looking
// for, and exactly the one a dropped report would take.
func (reg *Registry) Restore(events []contract.FleetEvent) {
	if len(events) == 0 {
		return
	}

	reg.mu.Lock()
	defer reg.mu.Unlock()

	reg.events = append(events, reg.events...)
	if len(reg.events) > MaxPendingEvents {
		reg.events = reg.events[len(reg.events)-MaxPendingEvents:]
	}
}

// Suspect marks a box that work this service dispatched just failed against.
//
// Evidence from the data path, which arrives before the staleness window does and never after it: a
// redeploy that went unanswered is a box in trouble now, not in twenty seconds. Cleared by the box's
// next beat, so a single lost packet costs one beat of placement rather than an eviction.
func (reg *Registry) Suspect(hostID, detail string, at time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	h, known := reg.hosts[hostID]
	if !known || h.Suspected {
		return
	}

	h.Suspected = true
	reg.hosts[hostID] = reg.observe(h, at, detail)
}

// Sweep records the boxes that have gone quiet since the last one.
//
// Staleness is computed when a row is read, so without this nothing ever notices it: a box that
// stopped beating is simply never chosen again, and no row anywhere says when it stopped.
func (reg *Registry) Sweep(now time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()

	for id, h := range reg.hosts {
		reg.hosts[id] = reg.observe(h, now, "")
	}
}

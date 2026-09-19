package fleet

import (
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	firstLife  = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
	secondLife = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
)

// A box nobody has seen before is a row of its own, so the history starts where the box does rather
// than at whatever it happened to be doing when something first looked.
func TestFirstBeatRegistersTheBox(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	events := reg.Drain()
	if len(events) != 1 {
		t.Fatalf("events: got %d, want the one that registers the box", len(events))
	}
	if events[0].Kind != contract.FleetRegistered {
		t.Fatalf("kind: got %q, want %q", events[0].Kind, contract.FleetRegistered)
	}
	if events[0].Incarnation != firstLife {
		t.Fatalf("incarnation: got %q, want the life the box beat in on", events[0].Incarnation)
	}
}

// Staleness is computed when a row is read, so nothing notices a box going quiet unless something
// sweeps: without this the fleet's history simply stops, with no row saying when or why.
func TestSweepRecordsABoxThatWentQuiet(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reg.Drain()

	reg.Sweep(epoch.Add(2 * staleAfter))

	events := reg.Drain()
	if len(events) != 1 {
		t.Fatalf("events: got %d, want the one that fails the box", len(events))
	}
	if events[0].Kind != contract.FleetFailed {
		t.Fatalf("kind: got %q, want %q", events[0].Kind, contract.FleetFailed)
	}
}

// The whole point of the leaving flag: a deploy and a crash are both silence, and only one of them
// is worth waking somebody for.
func TestALeavingBeatIsNotAFailure(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reg.Drain()

	goodbye := living(hostA, firstLife)
	goodbye.Leaving = true
	reg.Beat(goodbye, "192.0.2.1", epoch.Add(time.Second))

	events := reg.Drain()
	if len(events) != 1 || events[0].Kind != contract.FleetLeft {
		t.Fatalf("events: got %+v, want one %q", events, contract.FleetLeft)
	}

	// And it stays left rather than ageing into a failure once the window passes, or every deploy
	// becomes an incident an hour later.
	reg.Sweep(epoch.Add(10 * staleAfter))
	if extra := reg.Drain(); len(extra) != 0 {
		t.Fatalf("events after the window: got %+v, want none", extra)
	}
}

// A box back inside the staleness window never looked absent, so the restart is invisible without
// the incarnation — and the worlds its previous life was running are gone either way.
func TestANewIncarnationIsARestart(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reg.Drain()

	reg.Beat(living(hostA, secondLife), "192.0.2.1", epoch.Add(time.Second))

	events := reg.Drain()
	if len(events) != 1 || events[0].Kind != contract.FleetRestarted {
		t.Fatalf("events: got %+v, want one %q", events, contract.FleetRestarted)
	}
	if events[0].Incarnation != secondLife {
		t.Fatalf("incarnation: got %q, want the life that just started", events[0].Incarnation)
	}
}

// Evidence from the data path arrives before the staleness window does, and the box's own next beat
// is what outranks it: a single lost packet must cost one interval of placement, not an eviction.
func TestSuspicionHoldsUntilTheBoxBeatsAgain(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reg.Drain()

	reg.Suspect(hostA, "redeploy unanswered", epoch.Add(time.Second))

	if got := len(reg.Candidates("", epoch.Add(time.Second))); got != 0 {
		t.Fatalf("candidates while suspected: got %d, want none", got)
	}
	events := reg.Drain()
	if len(events) != 1 || events[0].Kind != contract.FleetSuspected {
		t.Fatalf("events: got %+v, want one %q", events, contract.FleetSuspected)
	}
	if events[0].Detail != "redeploy unanswered" {
		t.Fatalf("detail: got %q, want the signal the suspicion came from", events[0].Detail)
	}

	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch.Add(2*time.Second))

	if got := len(reg.Candidates("", epoch.Add(2*time.Second))); got != 1 {
		t.Fatalf("candidates after the box answered: got %d, want the box back", got)
	}
	back := reg.Drain()
	if len(back) != 1 || back[0].Kind != contract.FleetReturned {
		t.Fatalf("events: got %+v, want one %q", back, contract.FleetReturned)
	}
}

// One row per change and not one per sweep, or a box down overnight is thousands of identical rows
// and the history costs more to read than it answers.
func TestASweptBoxIsRecordedOnce(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reg.Drain()

	for i := 1; i <= 5; i++ {
		reg.Sweep(epoch.Add(time.Duration(i) * 2 * staleAfter))
	}

	if events := reg.Drain(); len(events) != 1 {
		t.Fatalf("events: got %d, want the one that says it failed", len(events))
	}
}

// A report that could not be delivered must not take the history with it: the box that failed and
// never came back is exactly the row an operator goes looking for.
func TestRestorePutsUndeliveredEventsBackOldestFirst(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	taken := reg.Drain()
	if len(taken) != 1 {
		t.Fatalf("drained: got %d, want 1", len(taken))
	}

	reg.Sweep(epoch.Add(2 * staleAfter))
	reg.Restore(taken)

	events := reg.Drain()
	if len(events) != 2 {
		t.Fatalf("events: got %d, want the restored one and the one recorded since", len(events))
	}
	if events[0].Kind != contract.FleetRegistered {
		t.Fatalf("order: got %q first, want the restored %q", events[0].Kind, contract.FleetRegistered)
	}
}

// Drain is a take, not a read: two readers would each report the same transition, and the receiver
// keys on an id per event precisely so it never has to.
func TestDrainLeavesNothingBehind(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	reg.Drain()
	if again := reg.Drain(); len(again) != 0 {
		t.Fatalf("second drain: got %+v, want nothing", again)
	}
}

// living is one beat from a box with a slot free, on the life it names.
func living(hostID, incarnation string) contract.HostHeartbeat {
	beat := oneSlot(hostID)
	beat.Incarnation = incarnation
	return beat
}

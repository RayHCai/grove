package fleet

import (
	"context"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const (
	staleAfter = 30 * time.Second

	hostA = "11111111-1111-4111-8111-111111111111"
	hostB = "22222222-2222-4222-8222-222222222222"

	gameID = "44444444-4444-4444-8444-444444444444"

	// Neither is a default, so a url built from a number compiled in would read as right and is not.
	agentPort   = 4104
	playerPort  = 4443
	gamePort    = 41337
	otherGameID = "88888888-8888-4888-8888-888888888888"
	instanceID  = "66666666-6666-4666-8666-666666666666"
	playerID    = "55555555-5555-4555-8555-555555555555"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// A join whose ranked box filled between the ranking and the commit takes the next box: the
// ranking runs outside the lock, so two joins hold the same order and only one can have the
// box it names first.
func TestPlaceFallsPastABoxThatFilledSinceTheRanking(t *testing.T) {
	reg := NewRegistry(staleAfter)
	for _, id := range []string{hostA, hostB} {
		reg.Beat(oneSlot(id), "192.0.2.1", epoch)
	}

	ordered := MostFree{}.Rank(context.Background(), request(gameID), reg.Candidates("", epoch))

	first, ok := reg.Place(request(gameID), ordered, epoch)
	if !ok {
		t.Fatal("first join: got no placement, want the box the ranking names first")
	}

	second, ok := reg.Place(request(otherGameID), ordered, epoch)
	if !ok {
		t.Fatal("second join: got no placement, want the box the first join left free")
	}
	if second.Host.ID == first.Host.ID {
		t.Fatalf("second join: got host %q, whose one slot the first join already spent", second.Host.ID)
	}
}

func oneSlot(hostID string) contract.HostHeartbeat {
	return contract.HostHeartbeat{
		HostID:     hostID,
		Region:     "us-east-1",
		AgentPort:  agentPort,
		PlayerPort: playerPort,
		TLS:        true,
		Ready:      true,
		Capacity:   contract.HostCapacity{MaxInstances: 1},
		ReportedAt: contract.Timestamp(epoch),
	}
}

func request(gameID string) contract.PlacementRequest {
	return contract.PlacementRequest{GameID: gameID, PlayerID: playerID}
}

// The router dials a box back on the port that box reported, never on one compiled in here.
func TestBeatKeepsTheAgentPortTheBoxReported(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(oneSlot(hostA), "192.0.2.1", epoch)

	candidates := reg.Candidates("", epoch)
	if len(candidates) != 1 {
		t.Fatalf("candidates: got %d, want 1", len(candidates))
	}
	if candidates[0].AgentPort != agentPort {
		t.Errorf("agentPort: got %d, want %d", candidates[0].AgentPort, agentPort)
	}
}

// A player dials the game process, so the placement has to carry the port that process bound.
func TestPlaceCarriesThePortTheBoxReportedForTheSession(t *testing.T) {
	sessionID := "77777777-7777-4777-8777-777777777777"

	beat := oneSlot(hostA)
	beat.Capacity.RunningInstances = 1
	beat.Instances = []contract.InstanceReport{{
		InstanceID: instanceID,
		GameID:     gameID,
		SessionID:  sessionID,
		State:      contract.InstanceHealthy,
		Port:       gamePort,
	}}

	reg := NewRegistry(staleAfter)
	reg.Beat(beat, "192.0.2.1", epoch)

	placed, ok := reg.Place(request(gameID), nil, epoch)
	if !ok {
		t.Fatal("got no placement, want the session the box is already running")
	}
	if placed.Port != gamePort {
		t.Errorf("port: got %d, want the bound %d", placed.Port, gamePort)
	}
	// The proxy's port and the world's id, never the child's own port, which faces nothing.
	if url := (ProxyIngress{}).URL(placed.Host, placed); url != "wss://192.0.2.1:4443/play/"+instanceID {
		t.Errorf("serverUrl: got %q", url)
	}
}

// A box still starting a session it was handed reports the port before it reports healthy, and the
// next joiner is sent to that world rather than to a second one.
func TestAHeldPlacementTakesThePortFromTheFirstBeatNamingIt(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(oneSlot(hostA), "192.0.2.1", epoch)

	first, ok := reg.Place(request(gameID), reg.Candidates("", epoch), epoch)
	if !ok {
		t.Fatal("first join: got no placement, want the one free box")
	}
	if first.Port != 0 {
		t.Errorf("port: got %d, want none before anything has spawned", first.Port)
	}

	beat := oneSlot(hostA)
	beat.Capacity.RunningInstances = 1
	beat.Instances = []contract.InstanceReport{{
		InstanceID: first.InstanceID,
		GameID:     gameID,
		SessionID:  first.SessionID,
		State:      contract.InstanceStarting,
		Port:       gamePort,
	}}
	reg.Beat(beat, "192.0.2.1", epoch)

	second, ok := reg.Place(request(gameID), nil, epoch)
	if !ok {
		t.Fatal("second join: got no placement, want the session the box is starting")
	}
	if second.SessionID != first.SessionID {
		t.Fatalf("sessionId: got %q, want the held %q", second.SessionID, first.SessionID)
	}
	if second.Port != gamePort {
		t.Errorf("port: got %d, want the bound %d", second.Port, gamePort)
	}
}

// Every url to a box is built from what the box reported: its name over its source address, and
// the scheme its own tls flag picks.
func TestTheIngressNamesTheBoxTheWayTheBoxNamedItself(t *testing.T) {
	const world = "9c858901-8a57-4791-81fe-4c455b099bc9"
	placed := Placement{InstanceID: world}

	cases := []struct {
		name string
		host Host
		want string
	}{
		{"a named box under tls", Host{Addr: "192.0.2.1", PublicHost: "box.fleet.grove.example", PlayerPort: 443, TLS: true}, "wss://box.fleet.grove.example:443/play/" + world},
		{"a box that named nothing, in development", Host{Addr: "192.0.2.1", PlayerPort: 4006}, "ws://192.0.2.1:4006/play/" + world},
		{"an ipv6 literal", Host{PublicHost: "2001:db8::7", PlayerPort: 443, TLS: true}, "wss://[2001:db8::7]:443/play/" + world},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := (ProxyIngress{}).URL(tc.host, placed); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// A box that says it cannot start a world is not offered one, though its running worlds stay joinable.
func TestAnUnreadyBoxTakesNoNewWorld(t *testing.T) {
	reg := NewRegistry(staleAfter)
	beat := oneSlot(hostA)
	beat.Ready = false
	reg.Beat(beat, "192.0.2.1", epoch)

	if got := len(reg.Candidates("", epoch)); got != 0 {
		t.Fatalf("candidates: got %d, want none from a box that cannot start one", got)
	}
}

// A farewell or a missed beat hides a box from new worlds only: the worlds it holds are still there.
func TestARunningWorldStaysJoinableThroughAFarewellAndAMissedBeat(t *testing.T) {
	const sessionID = "77777777-7777-4777-8777-777777777777"
	beat := oneSlot(hostA)
	beat.Capacity.RunningInstances = 1
	beat.Leaving = true
	beat.Instances = []contract.InstanceReport{{
		InstanceID: instanceID, GameID: gameID, SessionID: sessionID,
		State: contract.InstanceHealthy, Revision: 7, Port: gamePort,
	}}
	reg := NewRegistry(staleAfter)
	reg.Beat(beat, "192.0.2.1", epoch)

	join := request(gameID)
	join.Revision = 7
	cases := []struct {
		name   string
		at     time.Time
		joined bool
	}{
		{"just after the farewell", epoch.Add(time.Second), true},
		{"past one staleness window", epoch.Add(staleAfter + time.Second), true},
		{"past the join grace", epoch.Add(JoinGrace*staleAfter + time.Second), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := len(reg.Candidates("", tc.at)); got != 0 {
				t.Errorf("candidates: got %d, want the leaving box offered no new world", got)
			}
			placed, ok := reg.Place(join, nil, tc.at)
			if ok != tc.joined || (ok && placed.SessionID != sessionID) {
				t.Errorf("joined: got %t on %q, want %t", ok, placed.SessionID, tc.joined)
			}
		})
	}
}

// A box beats on its own clock, so a beat landing while Agent.Start is still running cannot name the
// session yet. Read as a refusal, it would free the slot under a world about to exist, and the next
// joiner would be sent into a second one.
func TestABeatMidStartKeepsTheReservation(t *testing.T) {
	reg := NewRegistry(staleAfter)
	beat := oneSlot(hostA)
	beat.Capacity.MaxInstances = 2
	reg.Beat(beat, "192.0.2.1", epoch)

	first, ok := reg.Place(request(gameID), reg.Candidates("", epoch), epoch)
	if !ok || !first.Starts {
		t.Fatalf("first join: got %+v, want a world to start", first)
	}

	reg.Beat(beat, "192.0.2.1", epoch.Add(time.Second))

	second, ok := reg.Place(request(gameID), reg.Candidates("", epoch), epoch.Add(time.Second))
	if !ok || second.SessionID != first.SessionID || second.Starts {
		t.Fatalf("a join during the start: got %+v, want the reserved session %q", second, first.SessionID)
	}

	// Once the box has answered the start, a beat that still does not name the session is a box
	// that has lost the work, and the next join ranks again.
	reg.Started(gameID, 0, first.SessionID, gamePort)
	reg.Beat(beat, "192.0.2.1", epoch.Add(2*time.Second))

	third, ok := reg.Place(request(gameID), reg.Candidates("", epoch), epoch.Add(2*time.Second))
	if !ok || third.SessionID == first.SessionID {
		t.Fatalf("a join after a started session went missing: got %+v, want a fresh session", third)
	}
}

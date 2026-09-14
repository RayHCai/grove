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
	gamePort    = 41337
	otherGameID = "88888888-8888-4888-8888-888888888888"
	playerID    = "55555555-5555-4555-8555-555555555555"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// A join whose ranked box filled between the ranking and the commit takes the next box in the order:
// the ranking runs outside the lock, so two joins hold the same order, and only one of them can have
// the box it names first.
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
	instanceID := "66666666-6666-4666-8666-666666666666"

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
	if url := (DirectIngress{}).URL(placed.Host, placed); url != "wss://192.0.2.1:41337/play" {
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

// The zero value is the secure spelling, so a fleet handing out cleartext urls was configured to.
func TestDirectIngressDefaultsToTheSecureScheme(t *testing.T) {
	host := Host{Addr: "192.0.2.1"}
	placed := Placement{Host: host, Port: gamePort}

	if url := (DirectIngress{}).URL(host, placed); url != "wss://192.0.2.1:41337/play" {
		t.Errorf("default scheme: got %q", url)
	}
	if url := (DirectIngress{Scheme: "ws"}).URL(host, placed); url != "ws://192.0.2.1:41337/play" {
		t.Errorf("named scheme: got %q", url)
	}
}

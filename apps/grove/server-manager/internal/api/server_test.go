package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/joins"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const (
	fleetSecret = "fleet-secret-of-at-least-32-characters"
	staleAfter  = 30 * time.Second

	hostA = "11111111-1111-4111-8111-111111111111"
	hostB = "22222222-2222-4222-8222-222222222222"
	hostC = "33333333-3333-4333-8333-333333333333"

	gameID      = "44444444-4444-4444-8444-444444444444"
	otherGameID = "88888888-8888-4888-8888-888888888888"
	thirdGameID = "99999999-9999-4999-8999-999999999999"

	playerID   = "55555555-5555-4555-8555-555555555555"
	instanceID = "66666666-6666-4666-8666-666666666666"
	sessionID  = "77777777-7777-4777-8777-777777777777"

	bundleHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	syncedHash = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

// httptest gives every request this address, and the ingress reads a box's address off the beat.
const beatFrom = "192.0.2.1"

// Neither is a default, so a url built from a number compiled into the router would read as wrong.
const (
	agentPort = 4104
	gamePort  = 41337
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// What the line is built with here. The depth is wide enough that no test in this file is refused
// for being behind others, and the deadline long enough that a slow machine is not a 409.
const (
	joinDepth    = 64
	joinDeadline = time.Second
)

// The version every join below is for, and the version every seeded world is running. A case that
// turns on two versions of one game names the other itself.
const revision = 7

// join is one player asking for a game, at the version and on the code every case here shares.
func join(game, region string) contract.PlacementRequest {
	return contract.PlacementRequest{
		GameID:   game,
		PlayerID: playerID,
		Revision: revision,
		Bundles:  bundles(),
		Region:   region,
	}
}

// harness is the service with a clock a test can move, so a host ages without anyone waiting.
type harness struct {
	handler http.Handler
	agent   *stubAgent

	// The worker answering the line reads this clock while a test moves it, so it is held under a
	// lock like any other state two goroutines share.
	clock sync.Mutex
	now   time.Time
}

func newHarness(t *testing.T) *harness { return newHarnessWithProbe(t, nil) }

// newHarnessWithProbe substitutes the readiness probe, since one that never fails cannot show that
// the route runs it.
func newHarnessWithProbe(t *testing.T, ready func(context.Context) error) *harness {
	t.Helper()

	h := &harness{now: epoch, agent: &stubAgent{}}
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	registry := fleet.NewRegistry(staleAfter)

	// The real line and the real ranking, wired the way main.go wires them: a fake line would only
	// ever prove that a fake line answers joins.
	line := joins.New(joins.Options{
		Queue: joins.NewMemory(joinDepth),
		Placer: fleet.Router{
			Registry:     registry,
			Balancer:     fleet.MostFree{},
			Ingress:      fleet.DirectIngress{},
			Agent:        h.agent,
			StartTimeout: joinDeadline / 2,
			Log:          discard,
			Now:          h.at,
		},
		Log:      discard,
		Deadline: joinDeadline,
	})

	answering, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	go line.Run(answering)

	server := New(Options{
		Registry:      registry,
		Joins:         line,
		Agent:         h.agent,
		Secret:        []byte(fleetSecret),
		Log:           discard,
		DeployTimeout: time.Second,
		HostTimeout:   time.Second,
		Now:           h.at,
		Ready:         ready,
	})

	h.handler = server.Handler()
	return h
}

func (h *harness) at() time.Time {
	h.clock.Lock()
	defer h.clock.Unlock()
	return h.now
}

func (h *harness) setAt(at time.Time) {
	h.clock.Lock()
	defer h.clock.Unlock()
	h.now = at
}

// stubAgent is every box in the fleet as the fan-out reaches it, so a test drives a refused
// connection and a box that answers nothing without a socket between them.
type stubAgent struct {
	mu    sync.Mutex
	asked []string
	// answer is what the box says. Nil is a box that drains the one world it holds of the game.
	answer func(host fleet.Host, gameID string) contract.HostDeployment

	// started is every world this fleet was asked to run, in the order it was asked.
	started []contract.InstanceStart
	// starts is what a box says to a start. Nil is a box that runs it and binds gamePort.
	starts func(host fleet.Host, req contract.InstanceStart) (contract.InstanceReport, error)
}

func (a *stubAgent) Redeploy(_ context.Context, host fleet.Host, gameID string) contract.HostDeployment {
	a.mu.Lock()
	a.asked = append(a.asked, host.ID)
	answer := a.answer
	a.mu.Unlock()

	if answer != nil {
		return answer(host, gameID)
	}
	return contract.HostDeployment{
		HostID:      host.ID,
		InstanceIDs: host.Holds(gameID),
		Status:      contract.DeployDraining,
	}
}

func (a *stubAgent) Start(_ context.Context, host fleet.Host, req contract.InstanceStart) (contract.InstanceReport, error) {
	a.mu.Lock()
	a.started = append(a.started, req)
	starts := a.starts
	a.mu.Unlock()

	if starts != nil {
		return starts(host, req)
	}
	return contract.InstanceReport{
		InstanceID: req.InstanceID,
		GameID:     req.GameID,
		SessionID:  req.SessionID,
		State:      contract.InstanceStarting,
		Revision:   req.Revision,
		Port:       gamePort,
	}, nil
}

// starts is every world this fleet was asked to run, in the order it was asked.
func (a *stubAgent) startsAsked() []contract.InstanceStart {
	a.mu.Lock()
	defer a.mu.Unlock()

	return slices.Clone(a.started)
}

func (a *stubAgent) dialled() []string {
	a.mu.Lock()
	defer a.mu.Unlock()

	sorted := slices.Clone(a.asked)
	slices.Sort(sorted)
	return sorted
}

func (h *harness) send(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
	t.Helper()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode %s %s: %v", method, path, err)
		}
		payload = bytes.NewReader(encoded)
	}

	req := httptest.NewRequest(method, path, payload)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

// box is one seeded host, whose beat arrived age before now — a large age is a box that went quiet.
type box struct {
	id        string
	region    string
	max       int
	running   int
	age       time.Duration
	instances []contract.InstanceReport
}

func (h *harness) seed(t *testing.T, boxes []box) {
	t.Helper()

	for _, b := range boxes {
		beat := contract.HostHeartbeat{
			HostID:    b.id,
			Region:    b.region,
			AgentPort: agentPort,
			Capacity: contract.HostCapacity{
				RunningInstances: b.running,
				MaxInstances:     b.max,
				CPULoad:          0.25,
				MemoryFreeBytes:  8 << 30,
			},
			Instances:  b.instances,
			ReportedAt: contract.Timestamp(epoch.Add(-b.age)),
		}

		h.setAt(epoch.Add(-b.age))
		rec := h.send(t, http.MethodPost, "/v1/hosts/"+b.id+"/heartbeat", beat, fleetSecret)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("heartbeat for %s: got %d, want 204 (%s)", b.id, rec.Code, rec.Body.String())
		}
	}
	h.setAt(epoch)
}

func (h *harness) place(t *testing.T, req contract.PlacementRequest) contract.Placement {
	t.Helper()

	rec := h.send(t, http.MethodPost, "/v1/placements", req, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("placement: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	return decode[contract.Placement](t, rec)
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()

	var body T
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestPlaceChoosesAHost(t *testing.T) {
	cases := []struct {
		name       string
		boxes      []box
		region     string
		wantStatus int
		wantHost   string
	}{
		{
			name: "the emptiest box takes the session",
			boxes: []box{
				{id: hostA, region: "us-east-1", max: 4, running: 3},
				{id: hostB, region: "us-east-1", max: 4, running: 1},
			},
			wantStatus: http.StatusOK,
			wantHost:   hostB,
		},
		{
			name: "a box that stopped beating is skipped however empty it is",
			boxes: []box{
				{id: hostA, region: "us-east-1", max: 16, running: 0, age: 2 * staleAfter},
				{id: hostB, region: "us-east-1", max: 2, running: 1},
			},
			wantStatus: http.StatusOK,
			wantHost:   hostB,
		},
		{
			name: "a box at its instance cap is not a candidate",
			boxes: []box{
				{id: hostA, region: "us-east-1", max: 2, running: 2},
				{id: hostB, region: "us-east-1", max: 4, running: 4},
			},
			wantStatus: http.StatusConflict,
		},
		{
			name: "a fleet that has all gone quiet places nothing",
			boxes: []box{
				{id: hostA, region: "us-east-1", max: 8, running: 0, age: 2 * staleAfter},
				{id: hostB, region: "us-east-1", max: 8, running: 0, age: 2 * staleAfter},
			},
			wantStatus: http.StatusConflict,
		},
		{
			name:       "an empty fleet places nothing",
			wantStatus: http.StatusConflict,
		},
		{
			name: "a named region is a filter, not a preference",
			boxes: []box{
				{id: hostA, region: "eu-west-1", max: 16, running: 0},
				{id: hostB, region: "us-east-1", max: 2, running: 1},
			},
			region:     "us-east-1",
			wantStatus: http.StatusOK,
			wantHost:   hostB,
		},
		{
			name: "a region with nothing healthy in it places nothing",
			boxes: []box{
				{id: hostA, region: "eu-west-1", max: 16, running: 0},
			},
			region:     "us-east-1",
			wantStatus: http.StatusConflict,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.seed(t, c.boxes)

			request := join(gameID, c.region)
			rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
			if rec.Code != c.wantStatus {
				t.Fatalf("status: got %d, want %d (%s)", rec.Code, c.wantStatus, rec.Body.String())
			}

			if c.wantStatus == http.StatusConflict {
				body := decode[httpx.ErrorBody](t, rec)
				if body.Code != httpx.CodeConflict || body.Message != "no capacity" {
					t.Fatalf("error body: got %+v, want conflict / no capacity", body)
				}
				return
			}

			placement := decode[contract.Placement](t, rec)
			if placement.HostID != c.wantHost {
				t.Fatalf("hostId: got %q, want %q", placement.HostID, c.wantHost)
			}
			if !contract.ValidUUID(placement.InstanceID) || !contract.ValidUUID(placement.SessionID) {
				t.Fatalf("minted ids must be uuids: %+v", placement)
			}

			// The port comes back in the box's own answer to the start, so a fresh placement names
			// a socket the player can dial rather than one they wait a whole heartbeat for.
			wantURL := fmt.Sprintf("wss://%s:%d/play", beatFrom, gamePort)
			if placement.ServerURL != wantURL {
				t.Fatalf("serverUrl: got %q, want %q", placement.ServerURL, wantURL)
			}
			if placement.Revision != revision {
				t.Fatalf("revision: got %d, want the %d it asked for", placement.Revision, revision)
			}
		})
	}
}

// Boxes that rank equal must not alternate, or one game's players spread over the whole fleet.
func TestPlaceBreaksTiesOnTheLowerHostID(t *testing.T) {
	h := newHarness(t)
	boxes := []box{
		{id: hostC, region: "us-east-1", max: 4, running: 1},
		{id: hostA, region: "us-east-1", max: 4, running: 1},
		{id: hostB, region: "us-east-1", max: 4, running: 1},
	}

	for attempt := range 25 {
		// A different game onto a re-beaten fleet every time, so what is under test is the ranking
		// and not what the attempt before it left on hostA.
		h.seed(t, boxes)

		request := join(contract.NewUUID(), "")
		placement := h.place(t, request)
		if placement.HostID != hostA {
			t.Fatalf("attempt %d: got host %q, want %q every time", attempt, placement.HostID, hostA)
		}
	}
}

// Two players joining a game between two beats share its world: the second is given the session the
// first was, because a second process for one game would be a second world.
func TestPlaceReturnsOneSessionForTwoJoinsBeforeABeat(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	request := join(gameID, "")
	first := h.place(t, request)

	second := h.place(t, request)
	if second.InstanceID != first.InstanceID || second.SessionID != first.SessionID {
		t.Fatalf("second join: got %+v, want the ids the first was given %+v", second, first)
	}
}

// A slot a placement has spent is spent, whatever the box's last beat counted, or one box takes the
// whole fleet's traffic until it beats again and then refuses most of it.
func TestPlaceStopsAtABoxesFreeSlots(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 2, running: 1}})

	h.place(t, join(gameID, ""))

	request := join(otherGameID, "")
	rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}

	body := decode[httpx.ErrorBody](t, rec)
	if body.Code != httpx.CodeConflict || body.Message != "no capacity" {
		t.Fatalf("error body: got %+v, want conflict / no capacity", body)
	}
}

// A box that beats without the session it was handed never took it, and holding the next joiner to
// an instance nothing ever started would cost that game the whole staleness window.
func TestABeatWithoutThePlacedSessionReleasesIt(t *testing.T) {
	h := newHarness(t)
	boxes := []box{{id: hostA, region: "us-east-1", max: 4, running: 0}}
	h.seed(t, boxes)

	request := join(gameID, "")
	first := h.place(t, request)

	h.seed(t, boxes)
	if second := h.place(t, request); second.SessionID == first.SessionID {
		t.Fatalf("sessionId: got %q, want one other than the session the box dropped", second.SessionID)
	}
}

// A session the box's own beat counts as running stops being held against its free slots as well,
// or a confirmed placement spends two of them and the fleet reports itself full at half its use.
func TestABeatThatConfirmsAPlacementStopsHoldingItsSlot(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	var live []contract.InstanceReport
	for _, game := range []string{gameID, otherGameID, thirdGameID} {
		request := join(game, "")
		rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
		if rec.Code != http.StatusOK {
			t.Fatalf("placement %d onto a box with 4 slots: got %d, want 200 (%s)",
				len(live)+1, rec.Code, rec.Body.String())
		}

		placed := decode[contract.Placement](t, rec)
		live = append(live, contract.InstanceReport{
			InstanceID: placed.InstanceID,
			GameID:     game,
			SessionID:  placed.SessionID,
			State:      contract.InstanceHealthy,
			Revision:   revision,
			Port:       gamePort + len(live),
		})
		// The box takes the work and counts it, which is what has to release the slot held here.
		h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: len(live), instances: live}})
	}
}

// A beat that names the reserved session draining or unhealthy takes it out of the joiner's way:
// the box has the work, but every later player for that game would be routed into a dying world.
func TestAHeldSessionTheBoxReportsSickIsNotJoined(t *testing.T) {
	for _, state := range []contract.InstanceState{contract.InstanceDraining, contract.InstanceUnhealthy} {
		t.Run(string(state), func(t *testing.T) {
			h := newHarness(t)
			h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

			request := join(gameID, "")
			first := h.place(t, request)

			h.seed(t, []box{{
				id: hostA, region: "us-east-1", max: 4, running: 1,
				instances: []contract.InstanceReport{{
					InstanceID: first.InstanceID, GameID: gameID,
					SessionID: first.SessionID, State: state, Revision: revision, Port: gamePort,
				}},
			}})

			if second := h.place(t, request); second.SessionID == first.SessionID {
				t.Fatalf("sessionId: got %q, want one other than the %s session", second.SessionID, state)
			}
		})
	}
}

// A box still starting the session it was handed has not dropped it, and a second joiner arriving
// mid-launch is given the same one rather than a second world for the same game.
func TestAHeldSessionTheBoxIsStillStartingIsJoined(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	request := join(gameID, "")
	first := h.place(t, request)

	h.seed(t, []box{{
		id: hostA, region: "us-east-1", max: 4, running: 1,
		instances: []contract.InstanceReport{{
			InstanceID: first.InstanceID, GameID: gameID,
			SessionID: first.SessionID, State: contract.InstanceStarting, Revision: revision, Port: gamePort,
		}},
	}})

	if second := h.place(t, request); second.SessionID != first.SessionID {
		t.Fatalf("sessionId: got %q, want the session the box is starting %q", second.SessionID, first.SessionID)
	}
}

// Joins for different games released together all land: they rank the same box first, and each
// one that loses the commit takes the next box rather than a 409 from a fleet with slots free.
// Eight at a time over several fleets, because two goroutines never reach the window.
func TestConcurrentJoinsAllLandWhileTheFleetHasFreeSlots(t *testing.T) {
	const joins = 8

	for round := range 10 {
		h := newHarness(t)
		boxes := make([]box, joins)
		bodies := make([][]byte, joins)
		for i := range joins {
			boxes[i] = box{id: contract.NewUUID(), region: "us-east-1", max: 2, running: 1}

			request := join(contract.NewUUID(), "")
			body, err := json.Marshal(request)
			if err != nil {
				t.Fatalf("encode placement %d: %v", i, err)
			}
			bodies[i] = body
		}
		h.seed(t, boxes)

		codes := make([]int, joins)
		start := make(chan struct{})
		var placed sync.WaitGroup

		for i := range joins {
			placed.Add(1)
			go func() {
				defer placed.Done()

				req := httptest.NewRequest(http.MethodPost, "/v1/placements", bytes.NewReader(bodies[i]))
				req.Header.Set("Authorization", "Bearer "+fleetSecret)
				rec := httptest.NewRecorder()
				<-start
				h.handler.ServeHTTP(rec, req)
				codes[i] = rec.Code
			}()
		}
		close(start)
		placed.Wait()

		for i, code := range codes {
			if code != http.StatusOK {
				t.Fatalf("round %d, join %d: got %d, want 200 — %d boxes each with a slot free took %d joins",
					round, i, code, joins, joins)
			}
		}
	}
}

// A second player of a running game joins its world rather than starting another one.
func TestPlaceJoinsASessionTheBoxAlreadyRuns(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{
		id: hostA, region: "us-east-1", max: 4, running: 1,
		instances: []contract.InstanceReport{{
			InstanceID:    instanceID,
			GameID:        gameID,
			SessionID:     sessionID,
			State:         contract.InstanceHealthy,
			Revision:      revision,
			Players:       3,
			UptimeSeconds: 120,
			Port:          gamePort,
		}},
	}})

	request := join(gameID, "")
	rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	placement := decode[contract.Placement](t, rec)
	if placement.InstanceID != instanceID || placement.SessionID != sessionID {
		t.Fatalf("placement: got %+v, want the running instance and session", placement)
	}
	// The game process, not the agent: the agent answers JSON behind the fleet bearer.
	wantURL := fmt.Sprintf("wss://%s:%d/play", beatFrom, gamePort)
	if placement.ServerURL != wantURL {
		t.Fatalf("serverUrl: got %q, want %q", placement.ServerURL, wantURL)
	}
}

// The first player into a version of a game is what makes a box run it: nothing else in the fleet
// ever starts a process, so a placement with no start behind it is an address dialling nothing.
func TestPlaceStartsTheWorldNoBoxIsRunning(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	placement := h.place(t, join(gameID, ""))

	started := h.agent.startsAsked()
	if len(started) != 1 {
		t.Fatalf("starts: got %d, want the one this join reserved", len(started))
	}
	if started[0].SessionID != placement.SessionID ||
		started[0].InstanceID != placement.InstanceID {
		t.Fatalf("started %+v, want the ids the player was handed %+v", started[0], placement)
	}
	// The box is told what to run as well as that it should run: it holds no build output of its
	// own, and a start naming no code is a process that cannot boot.
	if started[0].Revision != revision || started[0].Bundles.Client.Hash != bundles().Client.Hash {
		t.Fatalf("started %+v, want revision %d and the join's own bundles", started[0], revision)
	}
}

// A second joiner shares the world the first one started, so one game is one process.
func TestPlaceStartsOneWorldForTwoJoins(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	first := h.place(t, join(gameID, ""))
	second := h.place(t, join(gameID, ""))

	if second.SessionID != first.SessionID {
		t.Fatalf("second join: got session %q, want the first's %q", second.SessionID, first.SessionID)
	}
	if len(h.agent.startsAsked()) != 1 {
		t.Fatalf("starts: got %d, want one — a second is a second world", len(h.agent.startsAsked()))
	}
}

// A box that will not run the world is a placement nobody can be sent to, and the reservation it
// took has to go back: held, every later joiner would be handed a session nothing is starting.
func TestAStartTheBoxRefusesPlacesNothing(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})
	h.agent.starts = func(fleet.Host, contract.InstanceStart) (contract.InstanceReport, error) {
		return contract.InstanceReport{}, errors.New("connection refused")
	}

	rec := h.send(t, http.MethodPost, "/v1/placements", join(gameID, ""), fleetSecret)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}

	// The slot is back, so the next join ranks the same box again rather than finding it spent.
	h.agent.starts = nil
	if placement := h.place(t, join(gameID, "")); placement.HostID != hostA {
		t.Fatalf("after the refusal: got host %q, want %q", placement.HostID, hostA)
	}
}

// A rollout leaves the old world draining while the new version starts beside it. A joiner that
// fetched the new code must not be dropped into the old one, where it holds none of its scripts.
func TestPlaceWillNotJoinAWorldOnAnotherVersion(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{
		id: hostA, region: "us-east-1", max: 4, running: 1,
		instances: []contract.InstanceReport{{
			InstanceID: instanceID,
			GameID:     gameID,
			SessionID:  sessionID,
			State:      contract.InstanceHealthy,
			// One revision behind what the join below asks for.
			Revision: revision - 1,
			Players:  3,
			Port:     gamePort,
		}},
	}})

	placement := h.place(t, join(gameID, ""))

	if placement.SessionID == sessionID {
		t.Fatalf("sessionId: got the world on revision %d, want one on %d", revision-1, revision)
	}
	if placement.Revision != revision {
		t.Fatalf("revision: got %d, want %d", placement.Revision, revision)
	}
	if len(h.agent.startsAsked()) != 1 {
		t.Fatalf("starts: got %d, want the new version started beside the old", len(h.agent.startsAsked()))
	}
}

// Two versions of one game are two worlds, and each keeps its own joiners.
func TestPlaceKeepsAVersionsJoinersTogether(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	older := join(gameID, "")
	older.Revision = revision - 1
	first := h.place(t, older)
	newer := h.place(t, join(gameID, ""))

	if newer.SessionID == first.SessionID {
		t.Fatalf("sessionId: got the other version's %q, want a world of its own", first.SessionID)
	}
	// Both joiners of the older version share its world, which the newer one never reaches.
	if again := h.place(t, older); again.SessionID != first.SessionID {
		t.Fatalf("second join on the old version: got %q, want %q", again.SessionID, first.SessionID)
	}
}

func TestFleetCredentialGuardsV1(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		path       string
		bearer     string
		wantStatus int
	}{
		{
			name: "a heartbeat with no credential", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat", wantStatus: http.StatusUnauthorized,
		},
		{
			name: "the fleet listing with no credential", method: http.MethodGet,
			path: "/v1/hosts", wantStatus: http.StatusUnauthorized,
		},
		{
			name: "a placement with no credential", method: http.MethodPost,
			path: "/v1/placements", wantStatus: http.StatusUnauthorized,
		},
		{
			name: "a deployment with no credential", method: http.MethodPost,
			path: "/v1/deployments", wantStatus: http.StatusUnauthorized,
		},
		{
			name: "a credential that is not this fleet's", method: http.MethodGet,
			path: "/v1/hosts", bearer: "fleet-secret-of-at-least-32-characterZ",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name: "a credential that is only a prefix of it", method: http.MethodGet,
			path: "/v1/hosts", bearer: "fleet-secret", wantStatus: http.StatusUnauthorized,
		},
		{
			name: "the fleet credential", method: http.MethodGet,
			path: "/v1/hosts", bearer: fleetSecret, wantStatus: http.StatusOK,
		},
		{
			name: "health, which a supervisor polls holding none", method: http.MethodGet,
			path: "/health", wantStatus: http.StatusOK,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)

			rec := h.send(t, c.method, c.path, nil, c.bearer)
			if rec.Code != c.wantStatus {
				t.Fatalf("status: got %d, want %d (%s)", rec.Code, c.wantStatus, rec.Body.String())
			}
			if c.wantStatus != http.StatusUnauthorized {
				return
			}

			body := decode[httpx.ErrorBody](t, rec)
			if body.Code != httpx.CodeUnauthorized {
				t.Fatalf("error code: got %q, want %q", body.Code, httpx.CodeUnauthorized)
			}
		})
	}
}

// A supervisor polls readiness before this process holds a credential, exactly as it polls health,
// and the route answers from a probe rather than from the fact that the process is up.
func TestReadyIsOpenAndAnswersFromTheProbe(t *testing.T) {
	h := newHarness(t)

	rec := h.send(t, http.MethodGet, "/ready", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"ok":true}` {
		t.Errorf("body: got %s, want %s", got, `{"ok":true}`)
	}

	failing := newHarnessWithProbe(t, func(context.Context) error { return errors.New("not yet") })

	rec = failing.send(t, http.MethodGet, "/ready", nil, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503 (%s)", rec.Code, rec.Body.String())
	}
	if body := decode[httpx.ErrorBody](t, rec); body.Code != httpx.CodeInternal {
		t.Fatalf("error code: got %q, want %q", body.Code, httpx.CodeInternal)
	}
}

// The id a caller quotes in a bug report is the id this service's log lines carry, so it is echoed.
func TestRequestIDIsEchoed(t *testing.T) {
	cases := []struct {
		name      string
		presented string
		wantEcho  string
	}{
		{
			name:      "an id this service would have minted itself is carried",
			presented: hostA,
			wantEcho:  hostA,
		},
		{name: "a caller that sent none is given one"},
		{
			name:      "an id past the bound is replaced, because it is logged and forwarded",
			presented: strings.Repeat("a", contract.RequestIDMaxLen+1),
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)

			req := httptest.NewRequest(http.MethodGet, "/health", nil)
			if c.presented != "" {
				req.Header.Set(contract.RequestIDHeader, c.presented)
			}
			rec := httptest.NewRecorder()
			h.handler.ServeHTTP(rec, req)

			echoed := rec.Header().Get(contract.RequestIDHeader)
			if c.wantEcho != "" {
				if echoed != c.wantEcho {
					t.Fatalf("echo: got %q, want %q", echoed, c.wantEcho)
				}
				return
			}
			if !contract.ValidUUID(echoed) {
				t.Fatalf("echo: got %q, want a minted uuid", echoed)
			}
		})
	}
}

// A box that went quiet is kept and reported unhealthy: one that comes back resumes, and an
// operator can still see that it exists.
func TestHostsKeepsAStaleBoxAndMarksIt(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{
		{id: hostA, region: "us-east-1", max: 4, running: 1, age: 2 * staleAfter},
		{id: hostB, region: "eu-west-1", max: 4, running: 0},
	})

	rec := h.send(t, http.MethodGet, "/v1/hosts", nil, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	views := decode[[]contract.HostView](t, rec)
	if len(views) != 2 {
		t.Fatalf("rows: got %d, want 2", len(views))
	}
	if views[0].HostID != hostA || views[1].HostID != hostB {
		t.Fatalf("rows must order by hostId: got %q then %q", views[0].HostID, views[1].HostID)
	}
	if views[0].Liveness != contract.HostFailed {
		t.Fatalf("a box last heard from %s ago must have failed, got %q", 2*staleAfter, views[0].Liveness)
	}
	if views[1].Liveness != contract.HostHealthy {
		t.Fatalf("a box that has just beaten must be healthy, got %q", views[1].Liveness)
	}
	if views[0].LastSeenAt != contract.Timestamp(epoch.Add(-2*staleAfter)) {
		t.Fatalf("lastSeenAt: got %q, want when the beat was received", views[0].LastSeenAt)
	}
}

// A box gone far past the window is dropped instead: it re-registers itself if it ever comes back,
// so the listing holds only rows an operator can still act on.
func TestHostsDropsABoxGoneFarLongerThanTheWindow(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{
		{
			id: hostA, region: "us-east-1", max: 4, running: 0,
			age: (fleet.RetainWindows + 1) * staleAfter,
		},
		{id: hostB, region: "eu-west-1", max: 4, running: 0},
	})

	rec := h.send(t, http.MethodGet, "/v1/hosts", nil, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	views := decode[[]contract.HostView](t, rec)
	if len(views) != 1 || views[0].HostID != hostB {
		t.Fatalf("rows: got %+v, want %q alone", views, hostB)
	}
}

// holding is one box running a world of the game, which is what makes it a target of a rollout.
func holding(id, game, region string) box {
	return box{
		id: id, region: region, max: 4, running: 1,
		instances: []contract.InstanceReport{{
			InstanceID: id, GameID: game, SessionID: sessionID,
			State: contract.InstanceHealthy, Revision: revision, Port: gamePort,
		}},
	}
}

func (h *harness) deploy(t *testing.T, regions []string) contract.Deployment {
	t.Helper()

	request := contract.DeploymentRequest{GameID: gameID, Bundles: bundles(), Regions: regions}
	rec := h.send(t, http.MethodPost, "/v1/deployments", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	return decode[contract.Deployment](t, rec)
}

func hostIDs(rows []contract.HostDeployment) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.HostID)
	}
	return ids
}

func TestDeployReachesOnlyTheBoxesRunningTheGame(t *testing.T) {
	boxes := []box{
		holding(hostA, gameID, "us-east-1"),
		holding(hostB, gameID, "eu-west-1"),
		// Healthy and empty, so the version has nothing on it to end.
		{id: hostC, region: "us-east-1", max: 4, running: 0},
	}

	cases := []struct {
		name      string
		regions   []string
		wantHosts []string
	}{
		{"no region named reaches every box holding the game", nil, []string{hostA, hostB}},
		{"a named region stages the rollout", []string{"us-east-1"}, []string{hostA}},
		{"a region holding nothing reaches nothing", []string{"ap-south-1"}, nil},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.seed(t, boxes)

			deployment := h.deploy(t, c.regions)
			if got := hostIDs(deployment.Hosts); !slices.Equal(got, c.wantHosts) {
				t.Fatalf("rows: got %v, want %v", got, c.wantHosts)
			}
			// A box with nothing of this game on it is never dialled, so a fleet of idle boxes
			// costs a rollout no connections at all.
			if got := h.agent.dialled(); !slices.Equal(got, c.wantHosts) {
				t.Fatalf("dialled: got %v, want %v", got, c.wantHosts)
			}
			if deployment.DeployedAt != contract.Timestamp(epoch) {
				t.Fatalf("deployedAt: got %q, want %q", deployment.DeployedAt, contract.Timestamp(epoch))
			}
		})
	}
}

// A box that never answered is the row the report exists for, and one refused connection must not
// cost the account of every other box in the fleet.
func TestDeployReportsABoxThatCouldNotBeReached(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{
		holding(hostA, gameID, "us-east-1"),
		holding(hostB, gameID, "us-east-1"),
	})

	h.agent.answer = func(host fleet.Host, game string) contract.HostDeployment {
		if host.ID == hostA {
			return contract.HostDeployment{
				HostID: host.ID, InstanceIDs: []string{}, Status: contract.DeployFailed,
				Error: "dial: connection refused",
			}
		}
		return contract.HostDeployment{
			HostID: host.ID, InstanceIDs: host.Holds(game), Status: contract.DeployDraining,
		}
	}

	deployment := h.deploy(t, nil)
	if len(deployment.Hosts) != 2 {
		t.Fatalf("rows: got %+v, want one per box", deployment.Hosts)
	}
	if deployment.Hosts[0].Status != contract.DeployFailed || deployment.Hosts[0].Error == "" {
		t.Errorf("the unreachable box: got %+v, want a failed row carrying why", deployment.Hosts[0])
	}
	if deployment.Hosts[1].Status != contract.DeployDraining {
		t.Errorf("the box that answered: got %+v, want draining", deployment.Hosts[1])
	}
}

// The router must stop sending joiners into a world that is ending the moment the box says it is,
// rather than waiting a whole heartbeat to be told again.
func TestDeployStopsRoutingIntoADrainingWorld(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{holding(hostA, gameID, "us-east-1")})

	request := join(gameID, "")
	if joined := h.place(t, request); joined.SessionID != sessionID {
		t.Fatalf("before the rollout: got session %q, want the running %q", joined.SessionID, sessionID)
	}

	if rows := h.deploy(t, nil).Hosts; len(rows) != 1 || rows[0].Status != contract.DeployDraining {
		t.Fatalf("rollout: got %+v, want one draining row", rows)
	}

	if joined := h.place(t, request); joined.SessionID == sessionID {
		t.Fatalf("after the rollout: got the draining session %q again", joined.SessionID)
	}
}

// A box the fleet has handed a placement is starting a world its next beat has yet to name, and a
// rollout blind to it would leave that one box on the old version with no row saying so.
func TestDeployReachesABoxHoldingAPlacementItHasNotReportedYet(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{{id: hostA, region: "us-east-1", max: 4, running: 0}})

	h.place(t, join(gameID, ""))

	if got := hostIDs(h.deploy(t, nil).Hosts); !slices.Equal(got, []string{hostA}) {
		t.Fatalf("rows: got %v, want the box the placement went to", got)
	}
}

// An empty rollout must still serialise as a list, because the other end parses it with z.array.
func TestDeployAnswersWithAListEvenWhenItReachedNothing(t *testing.T) {
	h := newHarness(t)

	request := contract.DeploymentRequest{GameID: gameID, Bundles: bundles()}
	rec := h.send(t, http.MethodPost, "/v1/deployments", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"hosts":[]`)) {
		t.Fatalf("hosts must encode as an empty array: %s", rec.Body.String())
	}
}

func TestRefusedRequests(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{
			name: "a heartbeat whose body names another host", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat",
			body: contract.HostHeartbeat{
				HostID: hostB, Region: "us-east-1", ReportedAt: contract.Timestamp(epoch),
			},
		},
		{
			name: "a heartbeat from a host that is not a uuid", method: http.MethodPost,
			path: "/v1/hosts/box-7/heartbeat",
			body: contract.HostHeartbeat{
				HostID: "box-7", Region: "us-east-1", ReportedAt: contract.Timestamp(epoch),
			},
		},
		{
			name: "a heartbeat with no region", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat",
			body: contract.HostHeartbeat{HostID: hostA, ReportedAt: contract.Timestamp(epoch)},
		},
		{
			name: "a heartbeat reporting an instance in no known state", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat",
			body: contract.HostHeartbeat{
				HostID: hostA, Region: "us-east-1", ReportedAt: contract.Timestamp(epoch),
				Instances: []contract.InstanceReport{{
					InstanceID: instanceID, GameID: gameID, SessionID: sessionID, State: "wedged",
					Port: gamePort,
				}},
			},
		},
		{
			name: "a heartbeat that names no agent port", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat",
			body: contract.HostHeartbeat{
				HostID: hostA, Region: "us-east-1",
				Capacity:   contract.HostCapacity{MaxInstances: 4},
				ReportedAt: contract.Timestamp(epoch),
			},
		},
		{
			name: "a heartbeat reporting an instance on no port", method: http.MethodPost,
			path: "/v1/hosts/" + hostA + "/heartbeat",
			body: contract.HostHeartbeat{
				HostID: hostA, Region: "us-east-1", AgentPort: agentPort,
				Capacity:   contract.HostCapacity{MaxInstances: 4},
				ReportedAt: contract.Timestamp(epoch),
				Instances: []contract.InstanceReport{{
					InstanceID: instanceID, GameID: gameID, SessionID: sessionID,
					State: contract.InstanceHealthy,
				}},
			},
		},
		{
			name: "a placement for something that is not a game", method: http.MethodPost,
			path: "/v1/placements",
			body: join("game-7", ""),
		},
		{
			name: "a deployment whose halves disagree about the source", method: http.MethodPost,
			path: "/v1/deployments",
			body: contract.DeploymentRequest{GameID: gameID, Bundles: contract.BundleSet{
				Server: bundles().Server, Client: bundles().Client, SyncedHash: "not-a-hash",
			}},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)

			rec := h.send(t, c.method, c.path, c.body, fleetSecret)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: got %d, want 400 (%s)", rec.Code, rec.Body.String())
			}

			body := decode[httpx.ErrorBody](t, rec)
			if body.Code != httpx.CodeInvalidRequest {
				t.Fatalf("error code: got %q, want %q", body.Code, httpx.CodeInvalidRequest)
			}
		})
	}
}

func bundles() contract.BundleSet {
	return contract.BundleSet{
		Server: contract.BundleRef{
			Side: contract.SideServer, Hash: bundleHash,
			URL: "https://objects.grove.test/" + bundleHash, ByteLength: 4096,
		},
		Client: contract.BundleRef{
			Side: contract.SideClient, Hash: bundleHash,
			URL: "https://objects.grove.test/" + bundleHash, ByteLength: 2048,
		},
		SimConfig: contract.ConfigRef{
			Hash: syncedHash,
			URL:  "https://objects.grove.test/" + syncedHash + ".json", ByteLength: 142,
		},
		SyncedHash: syncedHash,
	}
}

func TestPlaceJoinsTheRunningBoxOverAnEmptierOne(t *testing.T) {
	h := newHarness(t)
	// hostB is emptier by exactly the slot hostA is spending on the game, which is what makes
	// ranking the wrong question: MostFree would send the second player to the box not running it.
	h.seed(t, []box{
		{
			id: hostA, region: "us-east-1", max: 4, running: 1,
			instances: []contract.InstanceReport{{
				InstanceID: instanceID, GameID: gameID, SessionID: sessionID,
				State: contract.InstanceHealthy, Players: 3, UptimeSeconds: 120, Revision: revision, Port: gamePort,
			}},
		},
		{id: hostB, region: "us-east-1", max: 4, running: 0},
	})

	request := join(gameID, "")
	rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	placement := decode[contract.Placement](t, rec)
	if placement.HostID != hostA {
		t.Errorf("hostId: got %q, want %q — the box already running the game", placement.HostID, hostA)
	}
	if placement.SessionID != sessionID {
		t.Errorf("sessionId: got %q, want the running session %q", placement.SessionID, sessionID)
	}
}

func TestAFullBoxStillTakesAJoinerForAGameItRuns(t *testing.T) {
	h := newHarness(t)
	// At its cap, so Candidates excludes it — joining a world that is already running starts no
	// process, so the cap is not the question being asked.
	h.seed(t, []box{{
		id: hostA, region: "us-east-1", max: 1, running: 1,
		instances: []contract.InstanceReport{{
			InstanceID: instanceID, GameID: gameID, SessionID: sessionID,
			State: contract.InstanceHealthy, Players: 8, UptimeSeconds: 600, Revision: revision, Port: gamePort,
		}},
	}})

	request := join(gameID, "")
	rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if placement := decode[contract.Placement](t, rec); placement.SessionID != sessionID {
		t.Errorf("sessionId: got %q, want the running session %q", placement.SessionID, sessionID)
	}
}

func TestAStaleBoxRunningTheGameIsNotJoined(t *testing.T) {
	h := newHarness(t)
	h.seed(t, []box{
		{
			id: hostA, region: "us-east-1", max: 4, running: 1, age: 2 * staleAfter,
			instances: []contract.InstanceReport{{
				InstanceID: instanceID, GameID: gameID, SessionID: sessionID,
				State: contract.InstanceHealthy, Players: 3, UptimeSeconds: 120, Revision: revision, Port: gamePort,
			}},
		},
		{id: hostB, region: "us-east-1", max: 4, running: 0},
	})

	request := join(gameID, "")
	rec := h.send(t, http.MethodPost, "/v1/placements", request, fleetSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	placement := decode[contract.Placement](t, rec)
	if placement.HostID != hostB {
		t.Errorf("hostId: got %q, want %q — the box that answered its last beat", placement.HostID, hostB)
	}
	if placement.SessionID == sessionID {
		t.Error("joined a session on a box that has gone quiet")
	}
}

package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const hostID = "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70"

// Not the default, so a beat that carried a compiled-in 4004 would read as right and is not.
const agentPort = 4104

type fakeSource struct {
	live    []contract.InstanceReport
	running int
	max     int
}

func (s fakeSource) Live() []contract.InstanceReport { return s.live }
func (s fakeSource) Running() int                    { return s.running }
func (s fakeSource) Max() int                        { return s.max }

type fakeBox struct {
	cpu  float64
	free int64
}

func (b fakeBox) Sample() (float64, int64) { return b.cpu, b.free }

func reports(n int) []contract.InstanceReport {
	out := make([]contract.InstanceReport, 0, n)
	for i := range n {
		out = append(out, contract.InstanceReport{
			InstanceID:    fmt.Sprintf("%08d-1111-4111-8111-111111111111", i),
			GameID:        hostID,
			SessionID:     fmt.Sprintf("%08d-2222-4222-8222-222222222222", i),
			State:         contract.InstanceHealthy,
			Players:       i,
			UptimeSeconds: int64(i * 10),
			Port:          41000 + i,
		})
	}
	return out
}

// caught is one beat as @grove/server-manager received it.
type caught struct {
	body      contract.HostHeartbeat
	bearer    string
	path      string
	requestID string
}

func catch(t *testing.T, r *http.Request, beats chan<- caught) {
	t.Helper()

	var body contract.HostHeartbeat
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode a beat: %v", err)
	}

	select {
	case beats <- caught{
		body:      body,
		bearer:    r.Header.Get("Authorization"),
		path:      r.URL.Path,
		requestID: r.Header.Get(contract.RequestIDHeader),
	}:
	default:
	}
}

func serverManager(t *testing.T, status int, beats chan<- caught) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		catch(t, r, beats)
		w.WriteHeader(status)
	}))
}

// A receiver that takes the whole beat and then drops the connection under it, which is the failure
// Send reports without a status: the beat is on the wire and no answer to it ever comes back.
func deafServerManager(t *testing.T, beats chan<- caught) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		catch(t, r, beats)

		conn, _, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack a beat: %v", err)
			return
		}
		conn.Close()
	}))
}

func newBeater(t *testing.T, url string, source Source) *Beater {
	t.Helper()

	return New(Options{
		ServerManagerURL: url,
		FleetSecret:      []byte("a-fleet-secret-of-at-least-32-chars"),
		HostID:           hostID,
		Region:           "us-east-1",
		AgentPort:        agentPort,
		Interval:         time.Hour,
		Source:           source,
		Box:              fakeBox{cpu: 0.25, free: 3 << 30},
		Log:              slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func TestABeatCarriesOneReportPerLiveChild(t *testing.T) {
	cases := []struct {
		name string
		live int
		max  int
	}{
		{name: "an idle box", live: 0, max: 8},
		{name: "one session", live: 1, max: 8},
		{name: "a full box", live: 8, max: 8},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			beats := make(chan caught, 1)
			upstream := serverManager(t, http.StatusNoContent, beats)
			defer upstream.Close()

			source := fakeSource{live: reports(tc.live), running: tc.live, max: tc.max}
			if _, err := newBeater(t, upstream.URL, source).Send(context.Background()); err != nil {
				t.Fatalf("Send: %v", err)
			}

			beat := <-beats
			if len(beat.body.Instances) != tc.live {
				t.Errorf("reports: got %d, want %d", len(beat.body.Instances), tc.live)
			}
			capacity := beat.body.Capacity
			if capacity.RunningInstances != tc.live || capacity.MaxInstances != tc.max {
				t.Errorf("capacity: got %+v", capacity)
			}
			if beat.body.HostID != hostID || beat.body.Region != "us-east-1" {
				t.Errorf("the box named itself as %q in %q", beat.body.HostID, beat.body.Region)
			}
			// A report without a port is a session the router can name and no player can reach.
			for i, report := range beat.body.Instances {
				if report.Port != 41000+i {
					t.Errorf("port for %s: got %d, want %d", report.InstanceID, report.Port, 41000+i)
				}
			}
			// The router decides healthy from this timestamp, so it has to be one it can parse.
			if _, err := contract.ParseTimestamp(beat.body.ReportedAt); err != nil {
				t.Errorf("reportedAt %q: %v", beat.body.ReportedAt, err)
			}
		})
	}
}

func TestABeatCarriesTheBoxItself(t *testing.T) {
	beats := make(chan caught, 1)
	upstream := serverManager(t, http.StatusNoContent, beats)
	defer upstream.Close()

	source := fakeSource{live: reports(2), running: 2, max: 4}
	requestID, err := newBeater(t, upstream.URL, source).Send(context.Background())
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	beat := <-beats
	if beat.bearer != "Bearer a-fleet-secret-of-at-least-32-chars" {
		t.Errorf("bearer: got %q", beat.bearer)
	}
	// The id Send reports is the one the receiver logs, or the two halves of a beat never join.
	if beat.requestID != requestID || !contract.ValidUUID(requestID) {
		t.Errorf("requestId: sent %q, arrived %q", requestID, beat.requestID)
	}
	// Spelled out rather than built from beatPath: this is the route @grove/server-manager
	// registers, and a test that derives it from the sender would agree with any typo.
	if want := "/v1/hosts/" + hostID + "/heartbeat"; beat.path != want {
		t.Errorf("path: got %q, want %q", beat.path, want)
	}
	if beat.body.Capacity.CPULoad != 0.25 || beat.body.Capacity.MemoryFreeBytes != 3<<30 {
		t.Errorf("the machine's own numbers: got %+v", beat.body.Capacity)
	}
	// The router dials this box back on it, rather than on a port compiled into the router.
	if beat.body.AgentPort != agentPort {
		t.Errorf("agentPort: got %d, want %d", beat.body.AgentPort, agentPort)
	}
}

func TestARefusedBeatIsAnError(t *testing.T) {
	beats := make(chan caught, 1)
	upstream := serverManager(t, http.StatusUnauthorized, beats)
	defer upstream.Close()

	requestID, err := newBeater(t, upstream.URL, fakeSource{max: 8}).Send(context.Background())
	if err == nil {
		t.Fatal("a refused beat reported success")
	}

	// Run logs the failure under this id, so the refusal and what the receiver refused grep as one.
	if beat := <-beats; beat.requestID != requestID || !contract.ValidUUID(requestID) {
		t.Errorf("requestId: sent %q, reported %q", beat.requestID, requestID)
	}
}

// The beat nobody answered is the hardest one to account for later, so it is reported under the id
// it really carried rather than under none.
func TestABeatThatGetsNoAnswerReportsTheIDItWentOutUnder(t *testing.T) {
	beats := make(chan caught, 1)
	upstream := deafServerManager(t, beats)
	defer upstream.Close()

	requestID, err := newBeater(t, upstream.URL, fakeSource{max: 8}).Send(context.Background())
	if err == nil {
		t.Fatal("a dropped connection reported success")
	}

	if beat := <-beats; beat.requestID != requestID || !contract.ValidUUID(requestID) {
		t.Errorf("requestId: sent %q, reported %q", beat.requestID, requestID)
	}
}

// A restarted box is placeable again as soon as it is up, which takes a beat before the first tick.
func TestRunBeatsBeforeItsFirstTick(t *testing.T) {
	beats := make(chan caught, 1)
	upstream := serverManager(t, http.StatusNoContent, beats)
	defer upstream.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		newBeater(t, upstream.URL, fakeSource{live: reports(1), running: 1, max: 8}).Run(ctx)
		close(done)
	}()

	select {
	case beat := <-beats:
		if len(beat.body.Instances) != 1 {
			t.Errorf("reports: got %d, want 1", len(beat.body.Instances))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no beat arrived before the interval elapsed")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run outlived its context")
	}
}

// Silence is how the router finds a crash, so a deploy that simply went quiet would read as one.
// This is the beat that says otherwise, and it is the only one that carries the flag.
func TestFarewellMarksTheBeatAsLeaving(t *testing.T) {
	var beats []contract.HostHeartbeat
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var beat contract.HostHeartbeat
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &beat)
		beats = append(beats, beat)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	beater := newBeater(t, server.URL, fakeSource{max: 4})

	if _, err := beater.Send(context.Background()); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if _, err := beater.Farewell(context.Background()); err != nil {
		t.Fatalf("Farewell: %v", err)
	}

	if len(beats) != 2 {
		t.Fatalf("beats: got %d, want the ordinary one and the farewell", len(beats))
	}
	if beats[0].Leaving {
		t.Fatal("an ordinary beat must not say the box is leaving")
	}
	if !beats[1].Leaving {
		t.Fatal("the farewell must say the box is leaving")
	}
}

// HostID survives a reboot on purpose, so without a second identity a box that crashed and came
// back inside the staleness window is a restart nothing upward can see.
func TestEveryBeatCarriesOneIncarnation(t *testing.T) {
	beater := newBeater(t, "http://127.0.0.1:1", fakeSource{max: 4})

	first := beater.Body(time.Now()).Incarnation
	second := beater.Body(time.Now().Add(time.Minute)).Incarnation

	if first == "" {
		t.Fatal("incarnation: got empty, want one minted when the agent started")
	}
	if first != second {
		t.Fatalf("incarnation: got %q then %q, want one fixed for the life of the agent", first, second)
	}
	if other := newBeater(t, "http://127.0.0.1:1", fakeSource{max: 4}).Body(time.Now()).Incarnation; other == first {
		t.Fatal("a second agent must not mint the incarnation the first one did")
	}
}

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

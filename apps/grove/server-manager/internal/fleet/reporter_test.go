package fleet

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

const reportSecret = "0123456789abcdef0123456789abcdef"

// The snapshot and the transitions travel together, because a receiver holding one without the
// other describes a fleet that never existed.
func TestSendCarriesTheFleetAndItsTransitions(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	var got contract.FleetReport
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()

	if err := reporterFor(reg, api.URL).Send(context.Background()); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if len(got.Hosts) != 1 || got.Hosts[0].HostID != hostA {
		t.Fatalf("hosts: got %+v, want the one box that beat in", got.Hosts)
	}
	if len(got.Events) != 1 || got.Events[0].Kind != contract.FleetRegistered {
		t.Fatalf("events: got %+v, want one %q", got.Events, contract.FleetRegistered)
	}
}

// The credential @grove/api gates this route on, which is never the one the boxes hold.
func TestSendPresentsTheCallerBearer(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	var presented string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()

	if err := reporterFor(reg, api.URL).Send(context.Background()); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if want := "Bearer " + reportSecret; presented != want {
		t.Fatalf("authorization: got %q, want %q", presented, want)
	}
}

// A receiver that was down must get the history rather than a hole in it: the snapshot is replaced
// by the next report, and a transition is carried by no other message at all.
func TestAFailedReportKeepsItsEventsForTheNextOne(t *testing.T) {
	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)

	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer refusing.Close()

	if err := reporterFor(reg, refusing.URL).Send(context.Background()); err == nil {
		t.Fatal("Send: got no error, want the one the 500 makes")
	}

	var got contract.FleetReport
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()

	if err := reporterFor(reg, api.URL).Send(context.Background()); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	if len(got.Events) != 1 || got.Events[0].Kind != contract.FleetRegistered {
		t.Fatalf("events: got %+v, want the one the refused report was holding", got.Events)
	}
}

// A development box with no @grove/api beside it: the registry still routes, and the reporter must
// cost nothing rather than log a failure every interval.
func TestAnUnconfiguredReporterIsNotAttached(t *testing.T) {
	if reporterFor(NewRegistry(staleAfter), "").Attached() {
		t.Fatal("a reporter with no API_URL must not be attached")
	}
}

func reporterFor(reg *Registry, apiURL string) *Reporter {
	return NewReporter(ReporterOptions{
		APIURL: apiURL,
		Secret: []byte(reportSecret),
		Fleet:  reg,
		Now:    func() time.Time { return epoch },
	})
}

// Run sweeps and reports on one tick until its context ends, so a box gone quiet reaches the history.
func TestRunSweepsAndReportsOnEveryTick(t *testing.T) {
	reports := make(chan contract.FleetReport, 8)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got contract.FleetReport
		_ = json.NewDecoder(r.Body).Decode(&got)
		reports <- got
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()

	reg := NewRegistry(staleAfter)
	reg.Beat(living(hostA, firstLife), "192.0.2.1", epoch)
	reporter := NewReporter(ReporterOptions{
		APIURL: api.URL, Secret: []byte(reportSecret), Fleet: reg,
		Interval: 10 * time.Millisecond, Now: func() time.Time { return epoch.Add(2 * staleAfter) },
	})

	ctx, stop := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	swept := make(chan time.Time, 8)
	go func() {
		reporter.Run(ctx, func(at time.Time) { reg.Sweep(at); swept <- at })
		close(stopped)
	}()

	var kinds []contract.FleetEventKind
	for len(kinds) < 2 {
		select {
		case report := <-reports:
			for _, event := range report.Events {
				kinds = append(kinds, event.Kind)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("events reported: got %v, want the registration and the failure the sweep found", kinds)
		}
	}
	if kinds[0] != contract.FleetRegistered || kinds[1] != contract.FleetFailed {
		t.Fatalf("events: got %v", kinds)
	}
	<-swept

	stop()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Run outlived its context")
	}
}

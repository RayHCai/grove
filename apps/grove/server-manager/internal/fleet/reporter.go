// What this service tells @grove/api about the fleet, so the history outlives the process holding it.
//
// The registry is the routing answer and is rebuilt from beats in one interval, which is why it can
// afford to live in memory. What it cannot rebuild is what the fleet *did* — a box that failed at
// 3am left no trace on any later beat — and that is the whole of what goes over this seam.

package fleet

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// The route on @grove/api that takes one report, behind the same fleet bearer every other
// service-to-service call in the fleet presents.
const reportPath = "/v1/fleet/reports"

// Drained and dropped: the answer is an acknowledgement and this service acts on nothing in it.
const maxReportAnswerBytes = 4 * 1024

// Fleet is the half of the registry a reporter reads. Narrow so the reporter can be driven without
// a registry at all, and so nothing about reporting can reach into placement.
type Fleet interface {
	Views(now time.Time) []contract.HostView
	Drain() []contract.FleetEvent
	Restore(events []contract.FleetEvent)
}

// ReporterOptions is everything one Reporter needs.
type ReporterOptions struct {
	APIURL      string
	FleetSecret []byte
	Fleet       Fleet
	// How often a report goes out with nothing to say. The snapshot is what keeps the receiver's
	// capacity rows from ageing, and it is deliberately far slower than a beat: a row per box per
	// beat would make every heartbeat a write in another service's database.
	Interval time.Duration
	Timeout  time.Duration
	Client   *http.Client
	Log      *slog.Logger
	Now      func() time.Time
}

// Reporter posts the fleet upward on a ticker, and owns nothing else.
type Reporter struct {
	opts ReporterOptions
	url  string
}

func NewReporter(opts ReporterOptions) *Reporter {
	if opts.Timeout == 0 {
		opts.Timeout = 5 * time.Second
	}
	if opts.Client == nil {
		opts.Client = &http.Client{Timeout: opts.Timeout}
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Reporter{
		opts: opts,
		url:  strings.TrimSuffix(opts.APIURL, "/") + reportPath,
	}
}

// Attached reports whether a receiver was configured. An unattached reporter is what a development
// box with no API beside it runs, and it must cost nothing rather than log a failure every interval.
func (r *Reporter) Attached() bool {
	return r.opts.APIURL != ""
}

// Send posts one report: the whole fleet, and every transition nobody has taken yet.
//
// Events are drained before the post and put back when it fails, so a receiver that was down gets
// the history rather than a hole in it. The snapshot needs no such care — the next one supersedes it.
func (r *Reporter) Send(ctx context.Context) error {
	now := r.opts.Now()
	events := r.opts.Fleet.Drain()

	report := contract.FleetReport{
		Hosts:      r.opts.Fleet.Views(now),
		Events:     events,
		ReportedAt: contract.Timestamp(now),
	}

	if err := r.post(ctx, report); err != nil {
		r.opts.Fleet.Restore(events)
		return err
	}
	return nil
}

func (r *Reporter) post(ctx context.Context, report contract.FleetReport) error {
	body, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("encode fleet report: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build fleet report: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(r.opts.FleetSecret))
	httpx.Forward(req)

	res, err := r.opts.Client.Do(req)
	if err != nil {
		return fmt.Errorf("post fleet report: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxReportAnswerBytes))

	if res.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("fleet report answered %d", res.StatusCode)
	}
	return nil
}

// Run reports until ctx ends, and sweeps the registry on the same tick.
//
// One ticker for both because the sweep is what produces the events the report carries: running them
// apart would let a report go out on the beat before the sweep that found what it should have said.
func (r *Reporter) Run(ctx context.Context, sweep func(time.Time)) {
	tick := time.NewTicker(r.opts.Interval)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}

		if sweep != nil {
			sweep(r.opts.Now())
		}
		if !r.Attached() {
			continue
		}
		if err := r.Send(ctx); err != nil && ctx.Err() == nil {
			r.opts.Log.Warn("fleet report failed", "err", err)
		}
	}
}

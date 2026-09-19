// Package heartbeat is what this box tells @grove/server-manager about itself, on a ticker.
package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/box"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// The route @grove/server-manager takes a beat on. The box names itself in the path and again in
// the body, and the receiver refuses a beat where the two disagree.
func beatPath(hostID string) string {
	return "/v1/hosts/" + url.PathEscape(hostID) + "/heartbeat"
}

// Drained but never kept: the answer is an acknowledgement, and this box acts on nothing in it.
const maxAnswerBytes = 4 * 1024

// Source is the half of the supervisor a beat reads. Narrow so a beat can be built for a box that
// never started a process.
type Source interface {
	Live() []contract.InstanceReport
	Running() int
	Max() int
}

// Options is everything one Beater needs.
type Options struct {
	ServerManagerURL string
	FleetSecret      []byte
	HostID           string
	Region           string
	// Where this agent listens, so the router reaches this box without a port compiled into it.
	AgentPort int
	Interval  time.Duration
	Source    Source
	Box       box.Sampler
	Client    *http.Client
	Log       *slog.Logger
	// Fixed for the life of this agent, and minted per Beater when unset. HostID survives a reboot
	// by design, so without this a box that crashed and came back inside the staleness window is a
	// restart nothing upward can see.
	Incarnation string
}

// Beater sends the beat and owns nothing else.
type Beater struct {
	opts Options
	url  string
}

// New builds the beater the composition root starts.
func New(opts Options) *Beater {
	if opts.Client == nil {
		opts.Client = &http.Client{Timeout: 5 * time.Second}
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Incarnation == "" {
		opts.Incarnation = contract.NewUUID()
	}
	return &Beater{
		opts: opts,
		url:  strings.TrimSuffix(opts.ServerManagerURL, "/") + beatPath(opts.HostID),
	}
}

// Body is one beat: the box, its capacity, and every instance on it.
//
// Every instance every time rather than a delta, so a dropped beat costs nothing to recover and the
// router never has to reconcile two views of one box.
func (b *Beater) Body(now time.Time) contract.HostHeartbeat {
	cpu, memory := b.opts.Box.Sample()

	return contract.HostHeartbeat{
		HostID:    b.opts.HostID,
		Region:    b.opts.Region,
		AgentPort: b.opts.AgentPort,
		Capacity: contract.HostCapacity{
			RunningInstances: b.opts.Source.Running(),
			MaxInstances:     b.opts.Source.Max(),
			CPULoad:          cpu,
			MemoryFreeBytes:  memory,
		},
		Instances:   b.opts.Source.Live(),
		Incarnation: b.opts.Incarnation,
		ReportedAt:  contract.Timestamp(now),
	}
}

// Send posts one beat and reports the id it went out under along with whether it landed.
func (b *Beater) Send(ctx context.Context) (string, error) {
	return b.post(ctx, b.Body(time.Now()))
}

// Farewell posts the one beat that says this box is going deliberately rather than dying.
// Sent after the listener drained, on a context of its own since the process's is cancelled.
// A failure is dropped: the router then concludes `failed` where it would have said `left`.
func (b *Beater) Farewell(ctx context.Context) (string, error) {
	body := b.Body(time.Now())
	body.Leaving = true
	return b.post(ctx, body)
}

func (b *Beater) post(ctx context.Context, beat contract.HostHeartbeat) (string, error) {
	body, err := json.Marshal(beat)
	if err != nil {
		return "", fmt.Errorf("encode heartbeat: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.url, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build heartbeat: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(b.opts.FleetSecret))
	// A beat sits inside no request, so it starts its own thread rather than joining one.
	requestID := httpx.Forward(req)

	res, err := b.opts.Client.Do(req)
	if err != nil {
		return requestID, fmt.Errorf("post heartbeat: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxAnswerBytes))

	if res.StatusCode >= http.StatusBadRequest {
		return requestID, fmt.Errorf("heartbeat answered %d", res.StatusCode)
	}
	return requestID, nil
}

// Run beats until ctx ends, starting with one immediately so a restarted box is placeable as
// soon as it is up. A failed beat is logged and dropped rather than retried: the next carries
// the whole state, and a queue of stale beats would describe the box as it was.
func (b *Beater) Run(ctx context.Context) {
	tick := time.NewTicker(b.opts.Interval)
	defer tick.Stop()

	for {
		if requestID, err := b.Send(ctx); err != nil && ctx.Err() == nil {
			b.opts.Log.Warn("heartbeat failed",
				"err", err, "hostId", b.opts.HostID, "requestId", requestID)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

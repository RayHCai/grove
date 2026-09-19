// What a child says about itself when this box asks.

package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// The path apps/grove/game-instance mounts its liveness check on.
const healthPath = "/healthz"

// Bounded because the reader is a poll loop: a child answering with a stream would otherwise hold
// this goroutine for as long as it kept writing.
const maxHealthBytes = 4 * 1024

// Vitals is what one probe learns. The child answers with a status and an optional body, so a bare
// 200 is a healthy instance reporting no roster.
type Vitals struct {
	Players int `json:"players"`
}

// Prober asks one child whether it is still serving, and reports the id it asked under.
// Narrow, so the poll loop never touches the network in a test where a fake answers for a
// process that was never forked.
type Prober interface {
	Probe(ctx context.Context, addr string) (Vitals, string, error)
}

type httpProber struct{ client *http.Client }

// NewHTTPProber polls a child over loopback, which is the only interface this agent reaches it on.
func NewHTTPProber(timeout time.Duration) Prober {
	return httpProber{client: &http.Client{Timeout: timeout}}
}

func (p httpProber) Probe(ctx context.Context, addr string) (Vitals, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+healthPath, nil)
	if err != nil {
		return Vitals{}, "", fmt.Errorf("build probe: %w", err)
	}
	// A poll sits inside no request, so it starts its own thread rather than joining one — and the
	// child echoes and logs that id, which is what joins two accounts of a box going quiet.
	requestID := httpx.Forward(req)

	res, err := p.client.Do(req)
	if err != nil {
		return Vitals{}, requestID, fmt.Errorf("probe %s: %w", addr, err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxHealthBytes))
	if err != nil {
		return Vitals{}, requestID, fmt.Errorf("read probe answer: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return Vitals{}, requestID, fmt.Errorf("probe %s answered %d", addr, res.StatusCode)
	}

	var v Vitals
	// A body that is not json is not a failure — the status is the answer.
	_ = json.Unmarshal(body, &v)
	return v, requestID, nil
}

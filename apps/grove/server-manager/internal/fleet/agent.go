// What this service says to a box: start one world, end one, or end a game's older worlds as their
// players leave.

package fleet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// ErrHostFull is a box refusing a start because it filled between the ranking and the call, which
// is the fleet being busy rather than anything failing: the join tries the next box, suspecting none.
var ErrHostFull = errors.New("the box is at its instance cap")

// Large enough for a box naming every world it holds, small enough that a box answering with a
// stream cannot spend this service's memory on one row.
const maxAgentAnswerBytes = 64 << 10

// Agent is one box's @grove/instance-manager, as this service reaches it.
//
// A seam because these are the only things in this service that leave the process: every partial
// failure a fleet has is driven through it in a test without a box, a socket or a timer.
type Agent interface {
	// Redeploy forwards a push and answers what the box did with it: the worlds of the game on any
	// revision but this one are drained. A row, not an error: an unreachable box is the report.
	Redeploy(ctx context.Context, h Host, gameID string, revision int) contract.HostDeployment
	// Start asks the box to run one world, and answers the process it now holds. An error, not a
	// row: the join that asked tries the next box in its ranking, or is refused.
	Start(ctx context.Context, h Host, req contract.InstanceStart) (contract.InstanceReport, error)
	// Stop ends one world, for a start that landed after everyone waiting on it had gone.
	Stop(ctx context.Context, h Host, instanceID string) error
}

// HTTPAgent dials the agent port a box reported, by the name the box reported, under TLS whenever
// the box serves it, which a production box always does.
type HTTPAgent struct {
	Client *http.Client
	Secret []byte
}

func (a HTTPAgent) Redeploy(ctx context.Context, h Host, gameID string, revision int) contract.HostDeployment {
	// The row names the box this service dialled and never the one the answer carried: a box that
	// named another would put its drain on another box's row.
	row := contract.HostDeployment{HostID: h.ID, InstanceIDs: []string{}}

	target := a.base(h) + "/v1/games/" + url.PathEscape(gameID) + "/redeploy"
	push := contract.RedeployRequest{Revision: revision}

	var answered contract.HostDeployment
	if _, err := a.fleet().PostJSON(ctx, target, push, &answered, maxAgentAnswerBytes); err != nil {
		// An agent that predates this route answers 404, which is the realistic failure in a fleet
		// whose boxes are replaced by scaling rather than by a rolling refresh.
		return failed(row, fmt.Errorf("redeploy: %w", err))
	}
	if !answered.Status.Valid() || answered.Status == contract.DeployFailed {
		// DeployFailed is this service's own verdict for a box that never answered, so a box
		// claiming it would be a box reporting itself unreachable.
		return failed(row, fmt.Errorf("the agent answered status %q", answered.Status))
	}

	row.Status = answered.Status
	if answered.InstanceIDs != nil {
		row.InstanceIDs = answered.InstanceIDs
	}
	return row
}

// Start asks one box to run a world, and reads back the process it holds. The bundles travel as
// refs: this service holds no build output, and a box caches them by content hash.
func (a HTTPAgent) Start(ctx context.Context, h Host, req contract.InstanceStart) (contract.InstanceReport, error) {
	var started contract.InstanceReport
	_, err := a.fleet().PostJSON(ctx, a.base(h)+"/v1/instances", req, &started, maxAgentAnswerBytes)

	// A 409 is the box saying it filled between the ranking and this call, the one refusal that is
	// not a fault.
	var status *httpx.StatusError
	if errors.As(err, &status) && status.Status == http.StatusConflict {
		return contract.InstanceReport{}, ErrHostFull
	}
	if err != nil {
		return contract.InstanceReport{}, fmt.Errorf("start: %w", err)
	}
	if started.Port < 1 {
		return contract.InstanceReport{}, fmt.Errorf("the agent named no port for %s", req.SessionID)
	}
	return started, nil
}

func (a HTTPAgent) Stop(ctx context.Context, h Host, instanceID string) error {
	target := a.base(h) + "/v1/instances/" + url.PathEscape(instanceID)
	if _, err := a.fleet().Call(ctx, http.MethodDelete, target, nil, nil, maxAgentAnswerBytes); err != nil {
		return fmt.Errorf("stop %s: %w", instanceID, err)
	}
	return nil
}

func (a HTTPAgent) fleet() httpx.FleetClient {
	return httpx.FleetClient{Client: a.Client, Secret: a.Secret}
}

// base is the agent's own listener on the name the box reported; the bearer it carries is the
// fleet secret, so a box that serves TLS is never dialled without it.
func (a HTTPAgent) base(h Host) string {
	scheme := "http"
	if h.TLS {
		scheme = "https"
	}
	return scheme + "://" + net.JoinHostPort(h.Dial(), strconv.Itoa(h.AgentPort))
}

// failed is the verdict only this service writes, since a box cannot report that it was unreachable.
func failed(row contract.HostDeployment, err error) contract.HostDeployment {
	row.Status = contract.DeployFailed
	row.Error = err.Error()
	return row
}

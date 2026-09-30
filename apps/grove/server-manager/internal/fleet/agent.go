// What this service says to a box: start one world, or end the worlds of a game as their players leave.

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
// is the fleet being busy rather than anything failing: the join falls to the next box in the order.
var ErrHostFull = errors.New("the box is at its instance cap")

// Large enough for a box naming every world it holds, small enough that a box answering with a
// stream cannot spend this service's memory on one row.
const maxAgentAnswerBytes = 64 << 10

// Agent is one box's @grove/instance-manager, as this service reaches it.
//
// A seam because these are the only things in this service that leave the process: every partial
// failure a fleet has is driven through it in a test without a box, a socket or a timer.
type Agent interface {
	// Redeploy forwards the request and answers what the box did with it.
	//
	// It returns a row rather than an error because an unreachable box is a fact the report is for:
	// a fan-out that failed on the first refused connection would tell an operator nothing about
	// the other nine boxes it never got to.
	Redeploy(ctx context.Context, h Host, gameID string) contract.HostDeployment
	// Start asks the box to run one world, and answers the process it now holds.
	//
	// An error rather than a row, because one join is not a fan-out: a box that would not start the
	// session is a placement nobody can be sent to, and the join has to rank again or be refused.
	Start(ctx context.Context, h Host, req contract.InstanceStart) (contract.InstanceReport, error)
}

// HTTPAgent dials the agent port a box reported, at the address that box's beat arrived from.
//
// Plaintext, because an agent terminates no TLS: the call crosses the internet to a port only the
// fleet's own address blocks may reach, and the bearer rides it readable by anything on the path.
type HTTPAgent struct {
	Client *http.Client
	Secret []byte
}

func (a HTTPAgent) Redeploy(ctx context.Context, h Host, gameID string) contract.HostDeployment {
	// The row names the box this service dialled and never the one the answer carried: a box that
	// named another would put its drain on another box's row.
	row := contract.HostDeployment{HostID: h.ID, InstanceIDs: []string{}}

	// No body: what a box runs is decided at start, so a bundle sent here would be one decision in two places.
	target := a.base(h) + "/v1/games/" + url.PathEscape(gameID) + "/redeploy"

	var answered contract.HostDeployment
	if _, err := a.fleet().PostJSON(ctx, target, nil, &answered, maxAgentAnswerBytes); err != nil {
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

	// A 409 is the box saying it filled between the ranking and this call, which is the one refusal
	// that is not a fault: the join falls to the next box rather than failing the fleet.
	var status *httpx.StatusError
	if errors.As(err, &status) && status.Status == http.StatusConflict {
		return contract.InstanceReport{}, ErrHostFull
	}
	if err != nil {
		return contract.InstanceReport{}, fmt.Errorf("start: %w", err)
	}

	// The port is the whole reason this answer is read rather than discarded: without it the
	// placement names no socket until the box's next beat, which is a URL no player can dial.
	if started.Port < 1 {
		return contract.InstanceReport{}, fmt.Errorf("the agent named no port for %s", req.SessionID)
	}
	return started, nil
}

func (a HTTPAgent) fleet() httpx.FleetClient {
	return httpx.FleetClient{Client: a.Client, Secret: a.Secret}
}

func (a HTTPAgent) base(h Host) string {
	return "http://" + net.JoinHostPort(h.Addr, strconv.Itoa(h.AgentPort))
}

// failed is the verdict only this service writes, since a box cannot report that it was unreachable.
func failed(row contract.HostDeployment, err error) contract.HostDeployment {
	row.Status = contract.DeployFailed
	row.Error = err.Error()
	return row
}

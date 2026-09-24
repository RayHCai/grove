// Package config reads the environment this service starts with, reporting every problem once.
package config

import (
	"fmt"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

// Config is everything the process needs before it binds a port.
type Config struct {
	Addr string
	Env  string
	// The shared bearer every box in the fleet presents. A different key from GAME_TOKEN_SECRET,
	// and a different blast radius.
	FleetSecret []byte
	// How long a host may go unheard before it stops taking work.
	StaleAfter time.Duration
	// The scheme a player's placement url is handed out under. Nothing in the fleet terminates TLS,
	// so this is a statement about whatever fronts it, and the insecure spelling has to be asked for.
	IngressScheme string
	// Where the line of waiting joins is held. Empty is a line in this process, which is what a
	// development box with no cache beside it runs.
	JoinQueueURL string
	// The key the line is held under, so two deployments sharing one cache do not share one line.
	JoinQueueKey string
	// How many joins may be waiting before this service refuses to take another.
	JoinQueueDepth int
	// How long one join may wait to be answered.
	JoinDeadline time.Duration
	// How long a box may hold the start of a world before the join that reserved it gives up.
	StartTimeout time.Duration
	// How long a whole fan-out may take, and how long any one box in it may hold its own answer.
	DeployTimeout time.Duration
	AgentTimeout  time.Duration
	// Where the fleet's history is kept. Empty reports to nothing, which is what a development box
	// with no @grove/api beside it runs — the registry still routes, and only the history is lost.
	APIURL string
	// How often the fleet is reported upward, and how often it is swept for boxes gone quiet. One
	// interval for both, because the sweep is what finds the transitions the report carries.
	ReportInterval time.Duration
}

// The abort @grove/api puts on a placement call. A join this service is still holding at that point
// has already been answered for it, so a deadline at or past this one can never be reached.
const callerAbort = 2 * time.Second

// Load reads r, which is the process environment in main and a fixed map in a test.
func Load(r *env.Reader) (Config, error) {
	var c Config

	// 0.0.0.0 rather than loopback: every box in the fleet dials this one, so binding to the
	// local interface would leave the registry hearing from nothing but itself.
	host := r.String("SERVER_MANAGER_HOST", "0.0.0.0")
	port := r.Port("SERVER_MANAGER_PORT", 4003)
	c.Addr = env.Addr(host, port)

	c.Env = r.OneOf("GROVE_ENV", "development", "development", "test", "production")
	c.FleetSecret = r.Secret("FLEET_SECRET", env.SecretMinLen)
	// Two missed beats at the agent's default interval. A false positive costs one interval of
	// placement on one box and ends no session, so the window is set to find a dead box quickly
	// rather than to be sure — and the box clears it by beating.
	c.StaleAfter = r.Duration("HOST_STALE_AFTER", 20*time.Second)
	c.IngressScheme = r.OneOf("INGRESS_SCHEME", "wss", "wss", "ws")

	c.JoinQueueURL = r.String("JOIN_QUEUE_URL", "")
	c.JoinQueueKey = r.String("JOIN_QUEUE_KEY", "grove:joins")
	c.JoinQueueDepth = r.Int("JOIN_QUEUE_DEPTH", 256)
	c.JoinDeadline = r.Duration("JOIN_DEADLINE", 1500*time.Millisecond)
	c.StartTimeout = r.Duration("START_TIMEOUT", time.Second)
	c.DeployTimeout = r.Duration("DEPLOY_TIMEOUT", 20*time.Second)
	c.AgentTimeout = r.Duration("AGENT_TIMEOUT", 5*time.Second)

	c.APIURL = r.String("API_URL", "")
	c.ReportInterval = r.Duration("FLEET_REPORT_INTERVAL", 15*time.Second)

	if err := r.Err(); err != nil {
		return Config{}, err
	}

	// Non-positive is not a tighter window but no window at all: every box is stale the instant it
	// beats, so the whole fleet stops taking work without anything having failed.
	if c.StaleAfter <= 0 {
		return Config{}, fmt.Errorf("HOST_STALE_AFTER must be positive, got %s", c.StaleAfter)
	}
	// A non-positive interval is a ticker that panics, and one past the staleness window is a fleet
	// whose history skips the boxes that failed and came back between two reports.
	if c.ReportInterval <= 0 || c.ReportInterval > c.StaleAfter {
		return Config{}, fmt.Errorf("FLEET_REPORT_INTERVAL must be positive and at most HOST_STALE_AFTER, got %s and %s",
			c.ReportInterval, c.StaleAfter)
	}
	// A line of nothing refuses every join, and a deadline at or past the caller's abort is one no
	// join can ever reach — both are a fleet that answers no one, with nothing having failed.
	if c.JoinQueueDepth <= 0 {
		return Config{}, fmt.Errorf("JOIN_QUEUE_DEPTH must be positive, got %d", c.JoinQueueDepth)
	}
	if c.JoinDeadline <= 0 || c.JoinDeadline >= callerAbort {
		return Config{}, fmt.Errorf("JOIN_DEADLINE must be positive and under %s, got %s",
			callerAbort, c.JoinDeadline)
	}
	// The start happens inside the join that reserved the world, so a box allowed to hold one for
	// longer than the whole join is a box whose answer arrives after the player was told no.
	if c.StartTimeout <= 0 || c.StartTimeout >= c.JoinDeadline {
		return Config{}, fmt.Errorf("START_TIMEOUT must be positive and under JOIN_DEADLINE, got %s and %s",
			c.StartTimeout, c.JoinDeadline)
	}
	// A box is asked inside the fan-out's own budget, so one that outlasts it would be a box whose
	// answer could never arrive in time to reach the report.
	if c.AgentTimeout <= 0 || c.DeployTimeout < c.AgentTimeout {
		return Config{}, fmt.Errorf("AGENT_TIMEOUT must be positive and at most DEPLOY_TIMEOUT, got %s and %s",
			c.AgentTimeout, c.DeployTimeout)
	}
	return c, nil
}

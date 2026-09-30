package config

import (
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

func complete() map[string]string {
	return map[string]string{"FLEET_SECRET": strings.Repeat("f", 32)}
}

func TestReadFillsTheDefaults(t *testing.T) {
	cfg, err := Read(env.FromMap(complete()))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if cfg.Addr() != "0.0.0.0:4003" {
		t.Errorf("addr: got %q, want 0.0.0.0:4003", cfg.Addr())
	}
	// Two missed beats at the agent's default interval, not three.
	if cfg.StaleAfter != 20*time.Second {
		t.Errorf("stale after: got %s, want 20s", cfg.StaleAfter)
	}
	// The secure spelling by default, so a fleet handing out cleartext urls was asked to.
	if cfg.IngressScheme != "wss" {
		t.Errorf("ingress scheme: got %q, want wss", cfg.IngressScheme)
	}
	// Unset is a line in this process, so a box running the whole fleet locally needs no cache.
	if cfg.JoinQueueURL != "" {
		t.Errorf("join queue url: got %q, want none", cfg.JoinQueueURL)
	}
	if cfg.JoinQueueKey != "grove:joins" || cfg.JoinQueueDepth != 256 {
		t.Errorf("join line: got %q at depth %d, want grove:joins at 256",
			cfg.JoinQueueKey, cfg.JoinQueueDepth)
	}
	if cfg.JoinDeadline != 1500*time.Millisecond {
		t.Errorf("join deadline: got %s, want 1.5s", cfg.JoinDeadline)
	}
	if cfg.DeployTimeout != 20*time.Second || cfg.AgentTimeout != 5*time.Second {
		t.Errorf("fan-out budgets: got %s and %s, want 20s and 5s",
			cfg.DeployTimeout, cfg.AgentTimeout)
	}
}

func TestReadRefusesAnEnvironmentItCannotRouteOn(t *testing.T) {
	cases := []struct {
		name    string
		change  func(map[string]string)
		mention string
	}{
		{
			name:    "no fleet secret",
			change:  func(m map[string]string) { delete(m, "FLEET_SECRET") },
			mention: "FLEET_SECRET",
		},
		{
			name:    "a fleet secret a guess would reach",
			change:  func(m map[string]string) { m["FLEET_SECRET"] = "short" },
			mention: "FLEET_SECRET",
		},
		{
			name:    "a port a listener would read as any free one",
			change:  func(m map[string]string) { m["SERVER_MANAGER_PORT"] = "0" },
			mention: "SERVER_MANAGER_PORT",
		},
		{
			name:    "an environment there is no log handler for",
			change:  func(m map[string]string) { m["GROVE_ENV"] = "staging" },
			mention: "GROVE_ENV",
		},
		{
			name:    "a staleness window that is not a duration",
			change:  func(m map[string]string) { m["HOST_STALE_AFTER"] = "a while" },
			mention: "HOST_STALE_AFTER",
		},
		{
			name:    "a staleness window no box can be fresh inside",
			change:  func(m map[string]string) { m["HOST_STALE_AFTER"] = "0s" },
			mention: "HOST_STALE_AFTER",
		},
		{
			name:    "an ingress scheme no browser opens a socket over",
			change:  func(m map[string]string) { m["INGRESS_SCHEME"] = "https" },
			mention: "INGRESS_SCHEME",
		},
		{
			name:    "a staleness window that runs backwards",
			change:  func(m map[string]string) { m["HOST_STALE_AFTER"] = "-5s" },
			mention: "HOST_STALE_AFTER",
		},
		{
			name:    "a line with room for nobody",
			change:  func(m map[string]string) { m["JOIN_QUEUE_DEPTH"] = "0" },
			mention: "JOIN_QUEUE_DEPTH",
		},
		{
			// The caller aborts at two seconds, so a join held past that is answered for this
			// service before it ever reaches its own deadline.
			name:    "a join deadline the caller has already given up on",
			change:  func(m map[string]string) { m["JOIN_DEADLINE"] = "2s" },
			mention: "JOIN_DEADLINE",
		},
		{
			name:    "a join deadline nothing can wait for",
			change:  func(m map[string]string) { m["JOIN_DEADLINE"] = "0s" },
			mention: "JOIN_DEADLINE",
		},
		{
			// The start runs inside the join that reserved the world, so a box allowed to hold one
			// for longer than the whole join answers after the player was already told no.
			name:    "a start given longer than the join waiting on it",
			change:  func(m map[string]string) { m["START_TIMEOUT"] = "1500ms" },
			mention: "START_TIMEOUT",
		},
		{
			name:    "a start given no time to happen at all",
			change:  func(m map[string]string) { m["START_TIMEOUT"] = "0s" },
			mention: "START_TIMEOUT",
		},
		{
			// A box asked for longer than the whole fan-out has is a box whose answer could never
			// reach the report.
			name:    "a box given longer than the rollout it is part of",
			change:  func(m map[string]string) { m["AGENT_TIMEOUT"] = "30s" },
			mention: "AGENT_TIMEOUT",
		},
		{
			name:    "a box given no time to answer at all",
			change:  func(m map[string]string) { m["AGENT_TIMEOUT"] = "0s" },
			mention: "AGENT_TIMEOUT",
		},
		{
			// Refused at boot rather than on the first report, which is fifteen seconds of looking fine.
			name:    "a history receiver that is not a url",
			change:  func(m map[string]string) { m["API_URL"] = "api:3000" },
			mention: "API_URL",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vars := complete()
			tc.change(vars)

			_, err := Read(env.FromMap(vars))
			if err == nil {
				t.Fatal("the environment was accepted")
			}
			if !strings.Contains(err.Error(), tc.mention) {
				t.Errorf("the error never names %s: %v", tc.mention, err)
			}
		})
	}
}

// A deployment that has no terminator in front of it says so, rather than handing out a url the
// browser refuses.
func TestReadTakesTheInsecureSchemeOnlyWhenAsked(t *testing.T) {
	vars := complete()
	vars["INGRESS_SCHEME"] = "ws"

	cfg, err := Read(env.FromMap(vars))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if cfg.IngressScheme != "ws" {
		t.Errorf("ingress scheme: got %q, want ws", cfg.IngressScheme)
	}
}

// A platform that assigns PORT is heard on it unless this service's own variable says otherwise.
func TestReadTakesThePlatformPort(t *testing.T) {
	vars := complete()
	vars["PORT"] = "8080"
	cfg, err := Read(env.FromMap(vars))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if cfg.Addr() != "0.0.0.0:8080" {
		t.Errorf("addr: got %q, want 0.0.0.0:8080", cfg.Addr())
	}

	vars["SERVER_MANAGER_PORT"] = "4103"
	if cfg, _ := Read(env.FromMap(vars)); cfg.Addr() != "0.0.0.0:4103" {
		t.Errorf("addr: got %q, want the service's own port", cfg.Addr())
	}
}

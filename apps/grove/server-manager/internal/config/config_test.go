package config

import (
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

// The seed node:crypto signs the token package's vectors with, so the key is one a verifier pairs.
const storeSeed = "ySjMqBN4rl4GCxpLhREJCFa_-F57bLOhFG75Jr_5YHg"

func complete() map[string]string {
	return map[string]string{
		"FLEET_SECRET":          strings.Repeat("f", 32),
		"SERVER_MANAGER_SECRET": strings.Repeat("c", 32),
		"STORE_SIGNING_KEY":     storeSeed,
	}
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
	if cfg.JoinQueueDepth != 256 || cfg.StartWorkers != 4 {
		t.Errorf("join line: got depth %d and %d start workers, want 256 and 4", cfg.JoinQueueDepth, cfg.StartWorkers)
	}
	if cfg.SuspectFor != 2*time.Minute || cfg.PlacementWarmup != 10*time.Second {
		t.Errorf("suspicion and warm-up: got %s and %s, want 2m and 10s", cfg.SuspectFor, cfg.PlacementWarmup)
	}
	if len(cfg.StoreKey) == 0 || len(cfg.CallerSecret) != 32 {
		t.Error("the store key or the caller secret was not read")
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
			name:    "no caller secret",
			change:  func(m map[string]string) { delete(m, "SERVER_MANAGER_SECRET") },
			mention: "SERVER_MANAGER_SECRET",
		},
		{
			// One credential for both pairs would let a box call the routes only @grove/api may.
			name:    "the caller secret and the fleet secret one value",
			change:  func(m map[string]string) { m["SERVER_MANAGER_SECRET"] = m["FLEET_SECRET"] },
			mention: "SERVER_MANAGER_SECRET",
		},
		{
			name:    "no key to sign a store bearer with",
			change:  func(m map[string]string) { delete(m, "STORE_SIGNING_KEY") },
			mention: "STORE_SIGNING_KEY",
		},
		{
			name:    "a signing key that is not a seed",
			change:  func(m map[string]string) { m["STORE_SIGNING_KEY"] = "c2hvcnQ" },
			mention: "STORE_SIGNING_KEY",
		},
		{
			name:    "a pool with nobody in it",
			change:  func(m map[string]string) { m["START_WORKERS"] = "0" },
			mention: "START_WORKERS",
		},
		{
			name:    "a suspicion that lasts no time",
			change:  func(m map[string]string) { m["SUSPECT_FOR"] = "0s" },
			mention: "SUSPECT_FOR",
		},
		{
			name:    "a warm-up past the staleness window",
			change:  func(m map[string]string) { m["PLACEMENT_WARMUP"] = "1m" },
			mention: "PLACEMENT_WARMUP",
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

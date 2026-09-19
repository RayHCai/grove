package config

import (
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

func complete() map[string]string {
	return map[string]string{
		"FLEET_SECRET":       strings.Repeat("f", 32),
		"SERVER_MANAGER_URL": "http://server-manager:4003",
		"GAME_MANAGER_URL":   "http://game-manager:4001",
		"HOST_ID":            "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		"HOST_REGION":        "us-east-1",
		"GAME_INSTANCE_BIN":  "/usr/local/bin/grove-game-instance",
		"GAME_TOKEN_SECRET":  strings.Repeat("g", 32),
	}
}

func TestReadFillsTheDefaults(t *testing.T) {
	cfg, err := Read(env.FromMap(complete()))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if cfg.Addr() != "0.0.0.0:4004" {
		t.Errorf("addr: got %q", cfg.Addr())
	}
	if cfg.MaxInstances != 8 {
		t.Errorf("max instances: got %d, want 8", cfg.MaxInstances)
	}
	if cfg.HeartbeatInterval != 10*time.Second {
		t.Errorf("heartbeat interval: got %s, want 10s", cfg.HeartbeatInterval)
	}
	// Defaulted rather than required, or every box provisioned before this agent kept any state
	// would fail its next restart.
	if cfg.StateDir != "/var/lib/grove" {
		t.Errorf("state dir: got %q, want /var/lib/grove", cfg.StateDir)
	}
}

func TestReadRefusesAnEnvironmentItCannotRunOn(t *testing.T) {
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
			name:    "a drain deadline no world could empty inside",
			change:  func(m map[string]string) { m["INSTANCE_DRAIN_DEADLINE"] = "0s" },
			mention: "INSTANCE_DRAIN_DEADLINE",
		},
		{
			name:    "no server-manager to beat to",
			change:  func(m map[string]string) { delete(m, "SERVER_MANAGER_URL") },
			mention: "SERVER_MANAGER_URL",
		},
		{
			name:    "a relative server-manager url",
			change:  func(m map[string]string) { m["SERVER_MANAGER_URL"] = "/fleet" },
			mention: "SERVER_MANAGER_URL",
		},
		{
			name:    "a host id the fleet cannot address",
			change:  func(m map[string]string) { m["HOST_ID"] = "box-7" },
			mention: "HOST_ID",
		},
		{
			name:    "the ec2 instance id a launch template used to write",
			change:  func(m map[string]string) { m["HOST_ID"] = "i-0abc123def4567890" },
			mention: "HOST_ID",
		},
		{
			name:    "no binary to spawn",
			change:  func(m map[string]string) { delete(m, "GAME_INSTANCE_BIN") },
			mention: "GAME_INSTANCE_BIN",
		},
		{
			name:    "a box that may hold nothing",
			change:  func(m map[string]string) { m["MAX_INSTANCES"] = "0" },
			mention: "MAX_INSTANCES",
		},
		{
			name:    "a heartbeat interval that is not a duration",
			change:  func(m map[string]string) { m["HEARTBEAT_INTERVAL"] = "often" },
			mention: "HEARTBEAT_INTERVAL",
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

// Three unset variables must cost one restart, not three.
func TestReadReportsEverythingAtOnce(t *testing.T) {
	vars := complete()
	delete(vars, "FLEET_SECRET")
	delete(vars, "HOST_REGION")
	delete(vars, "GAME_TOKEN_SECRET")

	_, err := Read(env.FromMap(vars))
	if err == nil {
		t.Fatal("the environment was accepted")
	}
	for _, name := range []string{"FLEET_SECRET", "HOST_REGION", "GAME_TOKEN_SECRET"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the error never names %s: %v", name, err)
		}
	}
}

// A secret never reaches a log, and an error is the first place one would.
func TestAnErrorNeverQuotesASecret(t *testing.T) {
	vars := complete()
	vars["GAME_TOKEN_SECRET"] = "too-short-to-be-a-secret"

	_, err := Read(env.FromMap(vars))
	if err == nil {
		t.Fatal("the environment was accepted")
	}
	if strings.Contains(err.Error(), "too-short-to-be-a-secret") {
		t.Errorf("the secret is in the error: %v", err)
	}
}

// The fleet secret rides every beat as a bearer, so production refuses a cleartext control plane.
func TestReadRefusesACleartextServerManagerInProduction(t *testing.T) {
	cases := []struct {
		name     string
		vars     map[string]string
		accepted bool
	}{
		{
			name:     "http in production",
			vars:     map[string]string{"GROVE_ENV": "production", "SERVER_MANAGER_URL": "http://server-manager:4003"},
			accepted: false,
		},
		{
			name:     "https in production",
			vars:     map[string]string{"GROVE_ENV": "production", "SERVER_MANAGER_URL": "https://server-manager:4003"},
			accepted: true,
		},
		// A box a person is watching talks to a control plane on their own machine.
		{
			name:     "http outside production",
			vars:     map[string]string{"SERVER_MANAGER_URL": "http://server-manager:4003"},
			accepted: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vars := complete()
			for name, value := range tc.vars {
				vars[name] = value
			}

			_, err := Read(env.FromMap(vars))
			if tc.accepted {
				if err != nil {
					t.Fatalf("Read: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("the environment was accepted")
			}
			if !strings.Contains(err.Error(), "SERVER_MANAGER_URL") {
				t.Errorf("the error never names SERVER_MANAGER_URL: %v", err)
			}
		})
	}
}

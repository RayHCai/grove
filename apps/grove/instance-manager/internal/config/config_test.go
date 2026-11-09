package config

import (
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

// Two keys, as a box holds them while the api's signer rotates.
const ticketKeys = "8kjXvyJlDRuF-yVsmSlpkVL2uSDZ1uQqOQpoPHBBJ_0,vZY3qLA8D_ZZUm6txr4Fx6qGZLZx7DHKODR1lKtDuVc"

// production is a box the fleet runs: named, encrypted and sandboxed.
func production() map[string]string {
	vars := complete()
	vars["GROVE_ENV"] = "production"
	vars["SERVER_MANAGER_URL"] = "https://server-manager.grove.example"
	vars["PUBLIC_HOST"] = "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70.fleet.grove.example"
	vars["TLS_CERT_FILE"] = "/etc/grove/tls/tls.crt"
	vars["TLS_KEY_FILE"] = "/etc/grove/tls/tls.key"
	vars["GAME_UID"] = "10002"
	vars["GAME_GID"] = "10002"
	vars["CGROUP_ROOT"] = "/sys/fs/cgroup/system.slice/grove-instance-manager.service"
	return vars
}

func complete() map[string]string {
	return map[string]string{
		"FLEET_SECRET":       strings.Repeat("f", 32),
		"SERVER_MANAGER_URL": "http://server-manager:4003",
		"GAME_MANAGER_URL":   "http://game-manager:4001",
		"HOST_ID":            "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		"HOST_REGION":        "us-east-1",
		"GAME_INSTANCE_BIN":  "/usr/local/bin/grove-game-instance",
		"TICKET_PUBLIC_KEYS": ticketKeys,
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
	if cfg.PlayerAddr() != "0.0.0.0:4006" || cfg.PlayerMaxConnections != 1024 || cfg.TLS() {
		t.Errorf("player proxy: got %s capped at %d, tls %t", cfg.PlayerAddr(), cfg.PlayerMaxConnections, cfg.TLS())
	}
	if cfg.ReapIdle != 5*time.Minute || cfg.ReapUnhealthyProbes != 10 || cfg.ReapTokenMargin != 30*time.Minute {
		t.Errorf("reaping: got idle %s, %d probes, margin %s", cfg.ReapIdle, cfg.ReapUnhealthyProbes, cfg.ReapTokenMargin)
	}
	if cfg.ChildMemoryMaxBytes != 1<<30 || cfg.ChildPidsMax != 256 || cfg.GameUID != 0 {
		t.Errorf("sandbox: got %d bytes, %d pids, uid %d", cfg.ChildMemoryMaxBytes, cfg.ChildPidsMax, cfg.GameUID)
	}
	if cfg.TicketPublicKeys != ticketKeys {
		t.Errorf("ticket keys: got %q, want the list as given", cfg.TicketPublicKeys)
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
			name:    "a ticket key that is not one",
			change:  func(m map[string]string) { m["TICKET_PUBLIC_KEYS"] = "c2hvcnQ" },
			mention: "TICKET_PUBLIC_KEYS",
		},
		{
			name:    "no ticket keys for a child to verify with",
			change:  func(m map[string]string) { delete(m, "TICKET_PUBLIC_KEYS") },
			mention: "TICKET_PUBLIC_KEYS",
		},
		{
			name:    "a public host no url can carry",
			change:  func(m map[string]string) { m["PUBLIC_HOST"] = "box.grove.example:443" },
			mention: "PUBLIC_HOST",
		},
		{
			name:    "a certificate with no key",
			change:  func(m map[string]string) { m["TLS_CERT_FILE"] = "/etc/grove/tls/tls.crt" },
			mention: "TLS_KEY_FILE",
		},
		{
			name:    "a player port that is the control port",
			change:  func(m map[string]string) { m["PLAYER_PORT"] = "4004" },
			mention: "PLAYER_PORT",
		},
		{
			name:    "a game uid with no group",
			change:  func(m map[string]string) { m["GAME_UID"] = "10002" },
			mention: "GAME_GID",
		},
		{
			name:    "a child held to fewer pids than a runtime needs",
			change:  func(m map[string]string) { m["CHILD_PIDS_MAX"] = "4" },
			mention: "CHILD_PIDS_MAX",
		},
		{
			name:    "a world that is never unhealthy enough to end",
			change:  func(m map[string]string) { m["REAP_UNHEALTHY_PROBES"] = "0" },
			mention: "REAP_UNHEALTHY_PROBES",
		},
		{
			// A world draining its whole deadline would outlive the bearer its saves need.
			name:    "a token margin inside the drain deadline",
			change:  func(m map[string]string) { m["REAP_TOKEN_MARGIN"] = "10m" },
			mention: "REAP_TOKEN_MARGIN",
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
	delete(vars, "TICKET_PUBLIC_KEYS")

	_, err := Read(env.FromMap(vars))
	if err == nil {
		t.Fatal("the environment was accepted")
	}
	for _, name := range []string{"FLEET_SECRET", "HOST_REGION", "TICKET_PUBLIC_KEYS"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the error never names %s: %v", name, err)
		}
	}
}

// A secret never reaches a log, and an error is the first place one would.
func TestAnErrorNeverQuotesASecret(t *testing.T) {
	vars := complete()
	vars["FLEET_SECRET"] = "too-short-to-be-a-secret"

	_, err := Read(env.FromMap(vars))
	if err == nil {
		t.Fatal("the environment was accepted")
	}
	if strings.Contains(err.Error(), "too-short-to-be-a-secret") {
		t.Errorf("the secret is in the error: %v", err)
	}
}

// Production is the box the internet reaches: it names itself, encrypts both listeners, and runs
// creator code as another user in a cgroup of its own.
func TestProductionRequiresANamedEncryptedSandboxedBox(t *testing.T) {
	if _, err := Read(env.FromMap(production())); err != nil {
		t.Fatalf("a whole production box: %v", err)
	}

	cases := []struct {
		name    string
		change  func(map[string]string)
		mention string
	}{
		{"a cleartext control plane", func(m map[string]string) { m["SERVER_MANAGER_URL"] = "http://server-manager:4003" }, "SERVER_MANAGER_URL"},
		{"no public host", func(m map[string]string) { delete(m, "PUBLIC_HOST") }, "PUBLIC_HOST"},
		{"no certificate", func(m map[string]string) { delete(m, "TLS_CERT_FILE"); delete(m, "TLS_KEY_FILE") }, "TLS_CERT_FILE"},
		{"children on this agent's own uid", func(m map[string]string) { delete(m, "GAME_UID"); delete(m, "GAME_GID") }, "GAME_UID"},
		{"no cgroup to hold a child in", func(m map[string]string) { delete(m, "CGROUP_ROOT") }, "CGROUP_ROOT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vars := production()
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

	// A box a person is watching talks to a control plane on their own machine, in the clear.
	if _, err := Read(env.FromMap(complete())); err != nil {
		t.Errorf("a development box: %v", err)
	}
}

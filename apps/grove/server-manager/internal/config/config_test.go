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

func TestLoadFillsTheDefaults(t *testing.T) {
	cfg, err := Load(env.FromMap(complete()))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Addr != "0.0.0.0:4003" {
		t.Errorf("addr: got %q, want 0.0.0.0:4003", cfg.Addr)
	}
	if cfg.StaleAfter != 30*time.Second {
		t.Errorf("stale after: got %s, want 30s", cfg.StaleAfter)
	}
	// The secure spelling by default, so a fleet handing out cleartext urls was asked to.
	if cfg.IngressScheme != "wss" {
		t.Errorf("ingress scheme: got %q, want wss", cfg.IngressScheme)
	}
}

func TestLoadRefusesAnEnvironmentItCannotRouteOn(t *testing.T) {
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
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vars := complete()
			tc.change(vars)

			_, err := Load(env.FromMap(vars))
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
func TestLoadTakesTheInsecureSchemeOnlyWhenAsked(t *testing.T) {
	vars := complete()
	vars["INGRESS_SCHEME"] = "ws"

	cfg, err := Load(env.FromMap(vars))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.IngressScheme != "ws" {
		t.Errorf("ingress scheme: got %q, want ws", cfg.IngressScheme)
	}
}

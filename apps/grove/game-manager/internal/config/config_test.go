package config

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

func TestRead(t *testing.T) {
	secret := strings.Repeat("k", 32)

	cases := []struct {
		name  string
		vars  map[string]string
		addr  string
		level slog.Level
		wants []string
	}{
		{
			name:  "the defaults bind loopback",
			vars:  map[string]string{"GAME_TOKEN_SECRET": secret},
			addr:  "127.0.0.1:4001",
			level: slog.LevelDebug,
		},
		{
			name: "a configured host and port",
			vars: map[string]string{
				"GAME_TOKEN_SECRET": secret,
				"GAME_MANAGER_HOST": "10.0.4.7",
				"GAME_MANAGER_PORT": "4101",
				"GROVE_ENV":         "production",
			},
			addr:  "10.0.4.7:4101",
			level: slog.LevelInfo,
		},
		{
			name:  "a secret shorter than the signing key",
			vars:  map[string]string{"GAME_TOKEN_SECRET": "short"},
			wants: []string{"GAME_TOKEN_SECRET"},
		},
		{
			name:  "three problems, reported together",
			vars:  map[string]string{"GROVE_ENV": "staging", "GAME_MANAGER_PORT": "http"},
			wants: []string{"GROVE_ENV", "GAME_MANAGER_PORT", "GAME_TOKEN_SECRET"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg, err := Read(env.FromMap(c.vars))

			if len(c.wants) > 0 {
				if err == nil {
					t.Fatal("err: got nil, want every problem at once")
				}
				for _, name := range c.wants {
					if !strings.Contains(err.Error(), name) {
						t.Errorf("err: %v, want it to name %s", err, name)
					}
				}
				return
			}

			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if cfg.Addr() != c.addr {
				t.Errorf("addr: got %s, want %s", cfg.Addr(), c.addr)
			}
			if cfg.LogLevel() != c.level {
				t.Errorf("level: got %v, want %v", cfg.LogLevel(), c.level)
			}
		})
	}
}

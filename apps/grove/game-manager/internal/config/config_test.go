package config

import (
	"strings"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

func TestRead(t *testing.T) {
	keys := "8kjXvyJlDRuF-yVsmSlpkVL2uSDZ1uQqOQpoPHBBJ_0,vZY3qLA8D_ZZUm6txr4Fx6qGZLZx7DHKODR1lKtDuVc"

	cases := []struct {
		name  string
		vars  map[string]string
		addr  string
		wants []string
	}{
		{
			name: "the defaults bind loopback",
			vars: map[string]string{"STORE_PUBLIC_KEYS": keys},
			addr: "127.0.0.1:4001",
		},
		{
			name: "a configured host and port",
			vars: map[string]string{
				"STORE_PUBLIC_KEYS": keys,
				"GAME_MANAGER_HOST": "10.0.4.7",
				"GAME_MANAGER_PORT": "4101",
				"GROVE_ENV":         "production",
			},
			addr: "10.0.4.7:4101",
		},
		{
			name: "a platform's PORT binds every interface on it",
			vars: map[string]string{"STORE_PUBLIC_KEYS": keys, "PORT": "8080"},
			addr: "0.0.0.0:8080",
		},
		{
			name: "the service's own port outranks the platform's",
			vars: map[string]string{"STORE_PUBLIC_KEYS": keys, "PORT": "8080", "GAME_MANAGER_PORT": "4101"},
			addr: "0.0.0.0:4101",
		},
		{
			name:  "a public key that is not 32 bytes",
			vars:  map[string]string{"STORE_PUBLIC_KEYS": "c2hvcnQ"},
			wants: []string{"STORE_PUBLIC_KEYS"},
		},
		{
			name:  "a key list with a blank entry",
			vars:  map[string]string{"STORE_PUBLIC_KEYS": "8kjXvyJlDRuF-yVsmSlpkVL2uSDZ1uQqOQpoPHBBJ_0,"},
			wants: []string{"STORE_PUBLIC_KEYS"},
		},
		{
			name:  "three problems, reported together",
			vars:  map[string]string{"GROVE_ENV": "staging", "GAME_MANAGER_PORT": "http"},
			wants: []string{"GROVE_ENV", "GAME_MANAGER_PORT", "STORE_PUBLIC_KEYS"},
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
			// Both halves of a rotation, so a bearer from either signer verifies.
			if len(cfg.StorePublicKeys) != 2 {
				t.Errorf("store public keys: got %d, want 2", len(cfg.StorePublicKeys))
			}
		})
	}
}

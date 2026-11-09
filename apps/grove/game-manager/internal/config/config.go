// Package config is the environment this process is started with, read once and reported once.
package config

import (
	"crypto/ed25519"

	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// Config is everything this service is told from outside it.
type Config struct {
	Env  string
	Host string
	Port int
	// The keys a world's store bearer may be signed with. Public halves only: this service never
	// mints a credential, so a breach of it forges none.
	StorePublicKeys []ed25519.PublicKey
}

// Read parses the whole environment before it reports, so three unset variables cost one restart.
func Read(r *env.Reader) (Config, error) {
	port, hosted := r.PlatformPort(4001)
	// Loopback unless a platform assigned PORT, whose router reaches the process from off the box.
	host := "127.0.0.1"
	if hosted {
		host = "0.0.0.0"
	}

	cfg := Config{
		Env:  r.Environment(),
		Host: r.String("GAME_MANAGER_HOST", host),
		Port: r.Port("GAME_MANAGER_PORT", port),
	}
	if raw := r.Required("STORE_PUBLIC_KEYS"); raw != "" {
		keys, err := token.ParsePublicKeys(raw)
		if err != nil {
			r.Refuse("STORE_PUBLIC_KEYS", err)
		}
		cfg.StorePublicKeys = keys
	}
	return cfg, r.Err()
}

// Addr is what the listener binds.
func (c Config) Addr() string {
	return env.Addr(c.Host, c.Port)
}

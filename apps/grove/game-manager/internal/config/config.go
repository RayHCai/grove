// Package config is the environment this process is started with, read once and reported once.
package config

import (
	"github.com/RayHCai/grove/libs/go-grove/env"
)

// Config is everything this service is told from outside it.
type Config struct {
	Env  string
	Host string
	Port int
	// The key @grove/api signs join tickets with. This service only ever verifies.
	TokenSecret []byte
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
		Env:         r.Environment(),
		Host:        r.String("GAME_MANAGER_HOST", host),
		Port:        r.Port("GAME_MANAGER_PORT", port),
		TokenSecret: r.Secret("GAME_TOKEN_SECRET", env.SecretMinLen),
	}
	return cfg, r.Err()
}

// Addr is what the listener binds.
func (c Config) Addr() string {
	return env.Addr(c.Host, c.Port)
}

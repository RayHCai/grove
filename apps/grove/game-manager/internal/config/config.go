// Package config is the environment this process is started with, read once and reported once.
package config

import (
	"log/slog"
	"net"
	"strconv"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

const secretMinLen = 32

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
	cfg := Config{
		Env: r.OneOf("GROVE_ENV", "development", "development", "test", "production"),
		// Loopback by default. This service is reachable from the fleet's own network and from
		// nowhere else, and a default of 0.0.0.0 is how that stops being true by accident.
		Host:        r.String("GAME_MANAGER_HOST", "127.0.0.1"),
		Port:        r.Port("GAME_MANAGER_PORT", 4001),
		TokenSecret: r.Secret("GAME_TOKEN_SECRET", secretMinLen),
	}
	return cfg, r.Err()
}

// Addr is what the listener binds.
func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// LogLevel is debug everywhere a person is watching, and info where a log aggregator is.
func (c Config) LogLevel() slog.Level {
	if c.Env == "production" {
		return slog.LevelInfo
	}
	return slog.LevelDebug
}

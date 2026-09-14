// Package config reads the environment this service is started with, and reports every problem once.
package config

import (
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

// Config is everything the process needs before it binds a port.
type Config struct {
	Addr string
	Env  string
	// The shared bearer every box in the fleet presents. A different key from GAME_TOKEN_SECRET,
	// and a different blast radius.
	FleetSecret []byte
	// How long a host may go unheard before it stops taking work.
	StaleAfter time.Duration
	// The scheme a player's placement url is handed out under. Nothing in the fleet terminates TLS,
	// so this is a statement about whatever fronts it, and the insecure spelling has to be asked for.
	IngressScheme string
}

// Load reads r, which is the process environment in main and a fixed map in a test.
func Load(r *env.Reader) (Config, error) {
	var c Config

	// 0.0.0.0 rather than loopback: every box in the fleet dials this one, so binding to the
	// local interface would leave the registry hearing from nothing but itself.
	host := r.String("SERVER_MANAGER_HOST", "0.0.0.0")
	port := r.Port("SERVER_MANAGER_PORT", 4003)
	c.Addr = net.JoinHostPort(host, strconv.Itoa(port))

	c.Env = r.OneOf("GROVE_ENV", "development", "development", "test", "production")
	c.FleetSecret = r.Secret("FLEET_SECRET", 32)
	c.StaleAfter = r.Duration("HOST_STALE_AFTER", 30*time.Second)
	c.IngressScheme = r.OneOf("INGRESS_SCHEME", "wss", "wss", "ws")

	if err := r.Err(); err != nil {
		return Config{}, err
	}

	// Non-positive is not a tighter window but no window at all: every box is stale the instant it
	// beats, so the whole fleet stops taking work without anything having failed.
	if c.StaleAfter <= 0 {
		return Config{}, fmt.Errorf("HOST_STALE_AFTER must be positive, got %s", c.StaleAfter)
	}
	return c, nil
}

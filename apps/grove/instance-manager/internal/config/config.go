// Package config is the environment this agent is started with, read once and reported once.
package config

import (
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/env"
)

// The floor @grove/api and @grove/game-instance both hold their secrets to.
const secretMinLen = 32

// Config is everything one box is told about itself.
type Config struct {
	Env  string
	Host string
	Port int
	// Shared with @grove/server-manager in both directions: the bearer on an inbound request, and
	// the one this agent presents when it beats.
	FleetSecret      []byte
	ServerManagerURL string
	// The uuid the fleet knows this box by. It is issued with the box, not chosen here.
	HostID            string
	Region            string
	MaxInstances      int
	HeartbeatInterval time.Duration
	GameInstanceBin   string
	// Where the children this box started are written down, so a restart of this agent finds the
	// ones it left running.
	StateDir string
	// Handed to every child, which verifies join tickets with it, and what this agent signs each
	// child's bearer for @grove/game-manager with.
	GameTokenSecret []byte
}

// Read parses the whole environment before it reports, so three unset variables cost one restart.
func Read(r *env.Reader) (Config, error) {
	cfg := Config{
		Env: r.OneOf("GROVE_ENV", "development", "development", "test", "production"),
		// Every interface, unlike the services behind it: @grove/server-manager reaches this agent
		// across the fleet network, and a box no one can address holds no sessions.
		Host:              r.String("INSTANCE_MANAGER_HOST", "0.0.0.0"),
		Port:              r.Port("INSTANCE_MANAGER_PORT", 4004),
		FleetSecret:       r.Secret("FLEET_SECRET", secretMinLen),
		ServerManagerURL:  r.URL("SERVER_MANAGER_URL"),
		HostID:            r.Required("HOST_ID"),
		Region:            r.Required("HOST_REGION"),
		MaxInstances:      r.Int("MAX_INSTANCES", 8),
		HeartbeatInterval: r.Duration("HEARTBEAT_INTERVAL", 10*time.Second),
		GameInstanceBin:   r.Required("GAME_INSTANCE_BIN"),
		// Defaulted rather than required: a box provisioned before this agent kept any state must
		// still start, and the directory is made on the first child it writes down.
		StateDir:        r.String("INSTANCE_STATE_DIR", "/var/lib/grove"),
		GameTokenSecret: r.Secret("GAME_TOKEN_SECRET", secretMinLen),
	}
	if err := r.Err(); err != nil {
		return Config{}, err
	}

	// Checked after that error, so an unset HOST_ID reads as missing rather than as malformed.
	if !contract.ValidUUID(cfg.HostID) {
		return Config{}, fmt.Errorf("HOST_ID must be a uuid, got %q", cfg.HostID)
	}
	// The fleet secret rides every beat as a bearer, so a cleartext control plane leaks it on a timer.
	if cfg.Env == "production" && !strings.HasPrefix(cfg.ServerManagerURL, "https://") {
		return Config{}, fmt.Errorf("SERVER_MANAGER_URL must be https in production, got %q", cfg.ServerManagerURL)
	}
	if cfg.MaxInstances < 1 {
		return Config{}, fmt.Errorf("MAX_INSTANCES must be at least 1, got %d", cfg.MaxInstances)
	}
	if cfg.HeartbeatInterval <= 0 {
		return Config{}, fmt.Errorf("HEARTBEAT_INTERVAL must be positive, got %s", cfg.HeartbeatInterval)
	}
	return cfg, nil
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

// Package config is the environment this agent is started with, read once and reported once.
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

// Config is everything one box is told about itself.
type Config struct {
	Env  string
	Host string
	Port int
	// Shared with @grove/server-manager in both directions: the bearer on an inbound request, and
	// the one this agent presents when it beats.
	FleetSecret      []byte
	ServerManagerURL string
	// Where @grove/game-manager is. Handed to every child, which reaches nothing else.
	GameManagerURL string
	// Where this box keeps the build output it has fetched, one file per content hash.
	BundleDir string
	// The uuid the fleet knows this box by. It is issued with the box, not chosen here.
	HostID            string
	Region            string
	MaxInstances      int
	HeartbeatInterval time.Duration
	// How long a world put into drain waits for its last player to leave.
	DrainDeadline   time.Duration
	GameInstanceBin string
	// Where the children this box started are written down, so a restart of this agent finds the
	// ones it left running.
	StateDir string
	// The keys a join ticket may be signed with, handed to every child verbatim; this box mints none.
	TicketPublicKeys string
	// The name players and the router reach this box by; empty only outside production.
	PublicHost string
	// Where the player proxy listens, and how many sockets it holds at once.
	PlayerPort           int
	PlayerMaxConnections int
	// The certificate both listeners serve, both set or neither.
	TLSCertFile string
	TLSKeyFile  string
	// Who a child runs as, never this agent: zero leaves a child on this agent's own uid.
	GameUID int
	GameGID int
	// The cgroup v2 directory systemd delegated to this agent, and what each child is held to there.
	CgroupRoot          string
	ChildMemoryMaxBytes int64
	ChildPidsMax        int
	// When a world ends unasked: idle this long, unanswered this many probes running, or this close
	// to the end of its store bearer.
	ReapIdle            time.Duration
	ReapUnhealthyProbes int
	ReapTokenMargin     time.Duration
}

// Read parses the whole environment before it reports, so three unset variables cost one restart.
func Read(r *env.Reader) (Config, error) {
	cfg := Config{
		Env: r.Environment(),
		// The control port is reached across the fleet network; the firewall, not the bind, keeps
		// it to the fleet's own blocks.
		Host:              r.String("INSTANCE_MANAGER_HOST", "0.0.0.0"),
		Port:              r.Port("INSTANCE_MANAGER_PORT", 4004),
		FleetSecret:       r.Secret("FLEET_SECRET", env.SecretMinLen),
		ServerManagerURL:  r.URL("SERVER_MANAGER_URL"),
		GameManagerURL:    r.URL("GAME_MANAGER_URL"),
		HostID:            r.Required("HOST_ID"),
		Region:            r.Required("HOST_REGION"),
		MaxInstances:      r.Int("MAX_INSTANCES", 8),
		HeartbeatInterval: r.Duration("HEARTBEAT_INTERVAL", 10*time.Second),
		DrainDeadline:     r.Duration("INSTANCE_DRAIN_DEADLINE", 15*time.Minute),
		GameInstanceBin:   r.Required("GAME_INSTANCE_BIN"),
		// Defaulted rather than required: a box provisioned before this agent kept any state must
		// still start, and the directory is made on the first child it writes down.
		StateDir:   r.String("INSTANCE_STATE_DIR", "/var/lib/grove"),
		BundleDir:  r.String("BUNDLE_CACHE_DIR", "/var/lib/grove/bundles"),
		PublicHost: r.String("PUBLIC_HOST", ""),
		PlayerPort: r.Port("PLAYER_PORT", 4006),
		// At most what one child holds, so the proxy is never the wider door.
		PlayerMaxConnections: r.Int("PLAYER_MAX_CONNECTIONS", 1024),
		TLSCertFile:          r.String("TLS_CERT_FILE", ""),
		TLSKeyFile:           r.String("TLS_KEY_FILE", ""),
		GameUID:              r.Int("GAME_UID", 0),
		GameGID:              r.Int("GAME_GID", 0),
		CgroupRoot:           r.String("CGROUP_ROOT", ""),
		ChildMemoryMaxBytes:  int64(r.Int("CHILD_MEMORY_MAX_BYTES", 1<<30)),
		ChildPidsMax:         r.Int("CHILD_PIDS_MAX", 256),
		ReapIdle:             r.Duration("REAP_IDLE", 5*time.Minute),
		ReapUnhealthyProbes:  r.Int("REAP_UNHEALTHY_PROBES", 10),
		ReapTokenMargin:      r.Duration("REAP_TOKEN_MARGIN", 30*time.Minute),
	}
	// Checked for shape here and passed on as written, so the child reads the list this box was given.
	if keys := r.Required("TICKET_PUBLIC_KEYS"); keys != "" {
		if _, err := token.ParsePublicKeys(keys); err != nil {
			r.Refuse("TICKET_PUBLIC_KEYS", err)
		}
		cfg.TicketPublicKeys = keys
	}
	if err := r.Err(); err != nil {
		return Config{}, err
	}
	if err := cfg.check(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// check holds the rules no single variable can state, after every variable has parsed.
func (c Config) check() error {
	production := c.Env == "production"
	// Checked after the read, so an unset HOST_ID reads as missing rather than as malformed.
	if !contract.ValidUUID(c.HostID) {
		return fmt.Errorf("HOST_ID must be a uuid, got %q", c.HostID)
	}
	// The fleet secret rides every beat as a bearer, so a cleartext control plane leaks it on a timer.
	if production && !strings.HasPrefix(c.ServerManagerURL, "https://") {
		return fmt.Errorf("SERVER_MANAGER_URL must be https in production, got %q", c.ServerManagerURL)
	}
	if c.PublicHost != "" && !contract.ValidHost(c.PublicHost) {
		return fmt.Errorf("PUBLIC_HOST must be a hostname or an ip literal, got %q", c.PublicHost)
	}
	// Behind a proxy the source address of a beat is the proxy's, so a production box names itself.
	if production && c.PublicHost == "" {
		return fmt.Errorf("PUBLIC_HOST is required in production")
	}
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE are set together or not at all")
	}
	// A player's ticket and the fleet secret both cross these listeners, so production encrypts them.
	if production && c.TLSCertFile == "" {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE are required in production")
	}
	if c.PlayerPort == c.Port {
		return fmt.Errorf("PLAYER_PORT must differ from INSTANCE_MANAGER_PORT, both %d", c.Port)
	}
	if c.GameUID < 0 || c.GameGID < 0 || (c.GameUID == 0) != (c.GameGID == 0) {
		return fmt.Errorf("GAME_UID and GAME_GID are set together, to a non-root user, or not at all")
	}
	// Creator code under this agent's own uid could read this agent's environment, the fleet secret in it.
	if production && (c.GameUID == 0 || c.CgroupRoot == "") {
		return fmt.Errorf("GAME_UID, GAME_GID and CGROUP_ROOT are required in production")
	}
	if c.ChildMemoryMaxBytes < 64<<20 || c.ChildPidsMax < 16 {
		return fmt.Errorf("CHILD_MEMORY_MAX_BYTES must be at least 64 MiB and CHILD_PIDS_MAX at least 16")
	}
	if c.MaxInstances < 1 || c.PlayerMaxConnections < 1 {
		return fmt.Errorf("MAX_INSTANCES and PLAYER_MAX_CONNECTIONS must be at least 1")
	}
	if c.DrainDeadline <= 0 || c.HeartbeatInterval <= 0 || c.ReapIdle <= 0 || c.ReapUnhealthyProbes < 1 {
		return fmt.Errorf("INSTANCE_DRAIN_DEADLINE, HEARTBEAT_INTERVAL, REAP_IDLE and REAP_UNHEALTHY_PROBES must be positive")
	}
	// A world draining for its whole deadline must still end before its store bearer does.
	if c.ReapTokenMargin <= c.DrainDeadline {
		return fmt.Errorf("REAP_TOKEN_MARGIN must exceed INSTANCE_DRAIN_DEADLINE, got %s and %s",
			c.ReapTokenMargin, c.DrainDeadline)
	}
	return nil
}

// Addr is what the control listener binds.
func (c Config) Addr() string {
	return env.Addr(c.Host, c.Port)
}

// PlayerAddr is what the player proxy binds: every interface, since players arrive from anywhere.
func (c Config) PlayerAddr() string {
	return env.Addr("0.0.0.0", c.PlayerPort)
}

// TLS reports whether both listeners serve it.
func (c Config) TLS() bool {
	return c.TLSCertFile != ""
}

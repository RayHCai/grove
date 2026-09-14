// Package contract mirrors libs/api-contract: the ids a Go service checks, and the wire shapes it
// exchanges with the TypeScript ones.
package contract

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// The bounds the zod schemas carry, so a Go handler refuses exactly what a Fastify one refuses.
const (
	StateKeyMaxLen          = 256
	LeaderboardNameMaxLen   = 64
	LeaderboardLimitDefault = 25
	LeaderboardLimitMax     = 100
	RegionMaxLen            = 32
	// Wide enough for a uuid, a 32-hex trace id or a w3c traceparent, and narrow enough that a
	// caller cannot spend a megabyte of every log line on a header nobody bounded.
	RequestIDMaxLen = 64
)

// RequestIDHeader is where a Go service reads the correlation id it logs and forwards, and where it
// echoes the one it chose, so a call crossing two of them greps as one line.
const RequestIDHeader = "X-Request-Id"

// RFC 9562 as `z.uuid()` reads it: a version nibble of 1-8 and a variant nibble of 8, 9, a or b,
// with the nil and max uuids admitted by name because the spec gives them both a meaning.
var uuidPattern = regexp.MustCompile(
	`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}` +
		`|00000000-0000-0000-0000-000000000000` +
		`|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

var contentHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Built from the bound rather than repeating it, since a pattern that disagreed with the constant
// would admit exactly the ids the constant exists to refuse.
var requestIDPattern = regexp.MustCompile(fmt.Sprintf(`^[0-9A-Za-z_-]{1,%d}$`, RequestIDMaxLen))

// ValidUUID reports whether s is an id every service on this boundary would accept.
func ValidUUID(s string) bool {
	return uuidPattern.MatchString(s)
}

// ValidContentHash reports whether s names an object. Lowercase hex only — a hash is a name, and
// two spellings of one name is two names.
func ValidContentHash(s string) bool {
	return contentHashPattern.MatchString(s)
}

// ValidRequestID reports whether s is one token a log, an echo header and an outbound call can all
// carry unchanged. A caller sends this, so it is bounded before it is ever written down.
func ValidRequestID(s string) bool {
	return requestIDPattern.MatchString(s)
}

// NewUUID mints the v4 uuid this fleet addresses everything by, in the shape ValidUUID reads.
func NewUUID() string {
	var b [16]byte
	// crypto/rand.Read fills b or halts the process, so there is no short read to handle.
	_, _ = rand.Read(b[:])

	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ValidURL reports whether s is what `z.url()` accepts, so a value this service stores and re-serves
// cannot be one the TypeScript half fails to parse. A scheme and a host, both required.
func ValidURL(s string) bool {
	parsed, err := url.Parse(s)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}

// Timestamp formats a time the way JavaScript's toISOString does, which is what `z.iso.datetime()`
// on the other side is written against.
func Timestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// ParseTimestamp reads one back, which is how a router decides `healthy` from a heartbeat's age.
//
// A trailing Z and no numeric offset, because that is the whole of what `z.iso.datetime()` admits
// with no options — a box whose clock formats an offset must fail here rather than be taken by one
// half of the fleet and refused by anything parsing the same beat with the declared schema.
func ParseTimestamp(s string) (time.Time, error) {
	if !strings.HasSuffix(s, "Z") {
		return time.Time{}, fmt.Errorf("parse timestamp %q: must be UTC, ending in Z", s)
	}
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse timestamp %q: %w", s, err)
	}
	return parsed.UTC(), nil
}

// StateValue is a `@serverState` value in flight. Raw on purpose: the store keeps the bytes a game
// wrote and hands them back unread, so a creator's shape is never something a service can break.
type StateValue = json.RawMessage

type StateRecord struct {
	Key      string     `json:"key"`
	Value    StateValue `json:"value"`
	Revision int64      `json:"revision"`
}

type StateWrite struct {
	Value StateValue `json:"value"`
	// A pointer because zero is a real revision: `omitempty` on a bare int would silently turn the
	// first compare-and-set of a key into a blind write.
	IfRevision *int64 `json:"ifRevision,omitempty"`
}

type LeaderboardQuery struct {
	Board  string `json:"board"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor,omitempty"`
}

type LeaderboardEntry struct {
	PlayerID    string  `json:"playerId"`
	DisplayName string  `json:"displayName"`
	Score       float64 `json:"score"`
	Rank        int     `json:"rank"`
}

// LeaderboardWrite is one player's standing, as a game process submits it.
//
// No rank: a rank is a position in a board rather than a property of a player, so it is assigned
// when a page is built and a writer that sent one would be sending a guess.
type LeaderboardWrite struct {
	Board       string  `json:"board"`
	PlayerID    string  `json:"playerId"`
	DisplayName string  `json:"displayName"`
	Score       float64 `json:"score"`
}

type LeaderboardPage struct {
	Board   string             `json:"board"`
	Entries []LeaderboardEntry `json:"entries"`
	// Null rather than absent at the end of a board, so a caller loops on one condition.
	NextCursor *string `json:"nextCursor"`
}

// BundleSide names which half of a game a bundle is, since both are built from one source.
type BundleSide string

const (
	SideServer BundleSide = "server"
	SideClient BundleSide = "client"
)

func (s BundleSide) Valid() bool {
	return s == SideServer || s == SideClient
}

// BundleRef is where a session fetches the code every peer must be running.
type BundleRef struct {
	Side       BundleSide `json:"side"`
	Hash       string     `json:"hash"`
	URL        string     `json:"url"`
	ByteLength int64      `json:"byteLength"`
}

type BundleSet struct {
	Server BundleRef `json:"server"`
	Client BundleRef `json:"client"`
	// Compared at the handshake: prediction is unsound exactly when the two ends differ here.
	SyncedHash string `json:"syncedHash"`
}

type PlacementRequest struct {
	GameID   string `json:"gameId"`
	PlayerID string `json:"playerId"`
	// Empty when the caller has no preference, and the fleet then chooses on load alone.
	Region string `json:"region,omitempty"`
}

// Placement is where a session was put. It carries no token: @grove/api adds the ticket it signs,
// so the secret a browser's credential is minted with never leaves the one service that holds it.
type Placement struct {
	HostID     string `json:"hostId"`
	InstanceID string `json:"instanceId"`
	SessionID  string `json:"sessionId"`
	ServerURL  string `json:"serverUrl"`
}

type HostCapacity struct {
	RunningInstances int     `json:"runningInstances"`
	MaxInstances     int     `json:"maxInstances"`
	CPULoad          float64 `json:"cpuLoad"`
	MemoryFreeBytes  int64   `json:"memoryFreeBytes"`
}

// InstanceState is what one game process is doing, as the box it runs on sees it.
type InstanceState string

const (
	InstanceStarting  InstanceState = "starting"
	InstanceHealthy   InstanceState = "healthy"
	InstanceDraining  InstanceState = "draining"
	InstanceUnhealthy InstanceState = "unhealthy"
)

func (s InstanceState) Valid() bool {
	switch s {
	case InstanceStarting, InstanceHealthy, InstanceDraining, InstanceUnhealthy:
		return true
	}
	return false
}

type InstanceReport struct {
	InstanceID    string        `json:"instanceId"`
	GameID        string        `json:"gameId"`
	SessionID     string        `json:"sessionId"`
	State         InstanceState `json:"state"`
	Players       int           `json:"players"`
	UptimeSeconds int64         `json:"uptimeSeconds"`
	// The port the box bound for this process, which is the one a player dials. On the wire rather
	// than assumed, because the kernel picks it and every guess is a port the firewall does not open.
	Port int `json:"port"`
}

// HostHeartbeat is what one @grove/instance-manager sends upward for the whole box at once.
type HostHeartbeat struct {
	HostID string `json:"hostId"`
	Region string `json:"region"`
	// Where this box's agent listens, so the router reaches it without a port compiled into it.
	AgentPort int          `json:"agentPort"`
	Capacity  HostCapacity `json:"capacity"`
	// Every instance every beat rather than a delta, so a dropped beat costs nothing to recover.
	Instances  []InstanceReport `json:"instances"`
	ReportedAt string           `json:"reportedAt"`
}

// HostView is one row of the fleet as the router sees it — `healthy` follows `lastSeenAt`, never a
// claim a box made about itself.
type HostView struct {
	HostID     string       `json:"hostId"`
	Region     string       `json:"region"`
	Capacity   HostCapacity `json:"capacity"`
	LastSeenAt string       `json:"lastSeenAt"`
	Healthy    bool         `json:"healthy"`
}

type DeploymentRequest struct {
	GameID string `json:"gameId"`
	// Both sides in one request, so the code a session runs is one decision rather than two.
	Bundles BundleSet `json:"bundles"`
	// Empty is the whole fleet; naming regions is what makes a rollout staged.
	Regions []string `json:"regions"`
}

type Deployment struct {
	GameID  string    `json:"gameId"`
	Bundles BundleSet `json:"bundles"`
	// The healthy boxes in the requested regions, which are the ones this version is for. Fewer than
	// the fleet is a staged rollout, not a failure.
	Hosts      []string `json:"hosts"`
	DeployedAt string   `json:"deployedAt"`
}

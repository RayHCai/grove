package contract

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The cases zod's `z.uuid()` regex distinguishes, so the two validators refuse the same strings.
func TestValidUUID(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want bool
	}{
		{"version 4", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10", true},
		{"version 7", "018f4d3e-1a2b-7c3d-8e4f-5a6b7c8d9e0f", true},
		{"version 1", "0b3f8a5e-2c4d-1f7a-9b1e-6d5c4a3b2e10", true},
		{"uppercase", "0B3F8A5E-2C4D-4F7A-9B1E-6D5C4A3B2E10", true},
		{"variant 8", "0b3f8a5e-2c4d-4f7a-8b1e-6d5c4a3b2e10", true},
		{"variant b", "0b3f8a5e-2c4d-4f7a-bb1e-6d5c4a3b2e10", true},
		{"the nil uuid", "00000000-0000-0000-0000-000000000000", true},
		{"the max uuid", "ffffffff-ffff-ffff-ffff-ffffffffffff", true},
		{"version 0", "0b3f8a5e-2c4d-0f7a-9b1e-6d5c4a3b2e10", false},
		{"version 9", "0b3f8a5e-2c4d-9f7a-9b1e-6d5c4a3b2e10", false},
		{"variant c", "0b3f8a5e-2c4d-4f7a-cb1e-6d5c4a3b2e10", false},
		{"no dashes", "0b3f8a5e2c4d4f7a9b1e6d5c4a3b2e10", false},
		{"too short", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e1", false},
		{"too long", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e100", false},
		{"not hex", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2exx", false},
		{"empty", "", false},
		{"leading newline", "\n0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10", false},
		{"trailing newline", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10\n", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidUUID(tt.id); got != tt.want {
				t.Errorf("ValidUUID(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestValidContentHash(t *testing.T) {
	const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

	tests := []struct {
		name string
		hash string
		want bool
	}{
		{"sha-256", sha, true},
		{"uppercase", "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08", false},
		{"too short", sha[:63], false},
		{"too long", sha + "0", false},
		{"not hex", sha[:63] + "z", false},
		{"empty", "", false},
		{"trailing newline", sha + "\n", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidContentHash(tt.hash); got != tt.want {
				t.Errorf("ValidContentHash(%q) = %v, want %v", tt.hash, got, tt.want)
			}
		})
	}
}

// `z.iso.datetime()` on the other side is written against what toISOString produces.
func TestTimestampMatchesToISOString(t *testing.T) {
	at := time.Date(2026, time.September, 6, 14, 43, 21, 0, time.UTC)
	if got := Timestamp(at); got != "2026-09-06T14:43:21.000Z" {
		t.Errorf("got %q", got)
	}

	// A non-UTC instant is still written as UTC, because the other half never sends an offset.
	east := time.FixedZone("UTC+2", 2*60*60)
	if got := Timestamp(at.In(east)); got != "2026-09-06T14:43:21.000Z" {
		t.Errorf("got %q", got)
	}
}

func TestTimestampRoundTrip(t *testing.T) {
	at := time.Date(2026, time.September, 6, 14, 43, 21, 0, time.UTC)

	got, err := ParseTimestamp(Timestamp(at))
	if err != nil {
		t.Fatalf("ParseTimestamp: %v", err)
	}
	if !got.Equal(at) {
		t.Errorf("got %v, want %v", got, at)
	}
}

func TestParseTimestamp(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"what toISOString writes", "2026-09-06T14:43:21.000Z", false},
		{"no fractional seconds", "2026-09-06T14:43:21Z", false},
		{"an offset", "2026-09-06T16:43:21+02:00", false},
		{"a date alone", "2026-09-06", true},
		{"no zone", "2026-09-06T14:43:21", true},
		{"not a time", "yesterday", true},
		{"empty", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseTimestamp(tt.in)
			if (err != nil) != tt.wantErr {
				t.Errorf("got %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestEnumsValid(t *testing.T) {
	for _, s := range []BundleSide{SideServer, SideClient} {
		if !s.Valid() {
			t.Errorf("BundleSide %q is one of the two", s)
		}
	}
	if BundleSide("both").Valid() {
		t.Error("BundleSide accepted a value the zod enum does not")
	}

	for _, s := range []InstanceState{InstanceStarting, InstanceHealthy, InstanceDraining, InstanceUnhealthy} {
		if !s.Valid() {
			t.Errorf("InstanceState %q is one of the four", s)
		}
	}
	if InstanceState("dead").Valid() {
		t.Error("InstanceState accepted a value the zod enum does not")
	}
}

// The json tags are the wire contract. A rename here is a field the TypeScript half stops seeing.
func TestHeartbeatEncodesTheZodShape(t *testing.T) {
	beat := HostHeartbeat{
		HostID: "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10",
		Region: "us-east-1",
		Capacity: HostCapacity{
			RunningInstances: 3,
			MaxInstances:     16,
			CPULoad:          0.42,
			MemoryFreeBytes:  8589934592,
		},
		Instances: []InstanceReport{{
			InstanceID:    "7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f",
			GameID:        "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",
			SessionID:     "2b9c8d7e-6f5a-4b3c-9d8e-7f6a5b4c3d2e",
			State:         InstanceHealthy,
			Players:       12,
			UptimeSeconds: 3600,
		}},
		ReportedAt: "2026-09-06T14:43:21.000Z",
	}

	const want = `{"hostId":"0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10","region":"us-east-1",` +
		`"capacity":{"runningInstances":3,"maxInstances":16,"cpuLoad":0.42,"memoryFreeBytes":8589934592},` +
		`"instances":[{"instanceId":"7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f","gameId":"f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",` +
		`"sessionId":"2b9c8d7e-6f5a-4b3c-9d8e-7f6a5b4c3d2e","state":"healthy","players":12,"uptimeSeconds":3600}],` +
		`"reportedAt":"2026-09-06T14:43:21.000Z"}`

	got, err := json.Marshal(beat)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(got) != want {
		t.Errorf("wire shape drifted\n got: %s\nwant: %s", got, want)
	}
}

func TestBundleSetEncodesTheZodShape(t *testing.T) {
	const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

	set := BundleSet{
		Server:     BundleRef{Side: SideServer, Hash: sha, URL: "https://objects.grove.test/" + sha, ByteLength: 2048},
		Client:     BundleRef{Side: SideClient, Hash: sha, URL: "https://objects.grove.test/" + sha, ByteLength: 4096},
		SyncedHash: sha,
	}

	got, err := json.Marshal(set)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	want := `{"server":{"side":"server","hash":"` + sha + `","url":"https://objects.grove.test/` + sha + `","byteLength":2048},` +
		`"client":{"side":"client","hash":"` + sha + `","url":"https://objects.grove.test/` + sha + `","byteLength":4096},` +
		`"syncedHash":"` + sha + `"}`
	if string(got) != want {
		t.Errorf("wire shape drifted\n got: %s\nwant: %s", got, want)
	}
}

// A `@serverState` value crosses unread, so whatever a creator wrote comes back byte for byte.
func TestStateValueIsCarriedUnread(t *testing.T) {
	const body = `{"key":"world","value":{"trees":[1,2,3],"weather":"rain"},"revision":7}`

	var rec StateRecord
	if err := json.Unmarshal([]byte(body), &rec); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if rec.Key != "world" || rec.Revision != 7 {
		t.Errorf("got %+v", rec)
	}
	if string(rec.Value) != `{"trees":[1,2,3],"weather":"rain"}` {
		t.Errorf("value was rewritten: %s", rec.Value)
	}

	got, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(got) != body {
		t.Errorf("round trip changed the record\n got: %s\nwant: %s", got, body)
	}
}

// Revision zero is a real revision, which is why IfRevision is a pointer rather than an int.
func TestStateWriteDistinguishesZeroFromAbsent(t *testing.T) {
	zero := int64(0)

	tests := []struct {
		name  string
		write StateWrite
		want  string
	}{
		{"a blind write", StateWrite{Value: json.RawMessage(`42`)}, `{"value":42}`},
		{"against revision 0", StateWrite{Value: json.RawMessage(`42`), IfRevision: &zero}, `{"value":42,"ifRevision":0}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(tt.write)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if string(got) != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

// The end of a board is a null the caller can loop on, never an absent field.
func TestLeaderboardPageEndsWithNull(t *testing.T) {
	page := LeaderboardPage{
		Board:   "high-scores",
		Entries: []LeaderboardEntry{{PlayerID: "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b", DisplayName: "ray", Score: 12.5, Rank: 1}},
	}

	got, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	const want = `{"board":"high-scores","entries":[{"playerId":"f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",` +
		`"displayName":"ray","score":12.5,"rank":1}],"nextCursor":null}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestPlacementRequestOmitsAnAbsentRegion(t *testing.T) {
	req := PlacementRequest{
		GameID:   "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",
		PlayerID: "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10",
	}

	got, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	const want = `{"gameId":"f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b","playerId":"0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10"}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// What a caller may put in the correlation header: one grep token, bounded, and nothing a log line
// would have to escape.
func TestValidRequestID(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want bool
	}{
		{"a uuid", "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10", true},
		{"a 32-hex trace id", "4bf92f3577b34da6a3ce929d0e0e4736", true},
		{"underscores", "job_17_attempt_2", true},
		{"a single character", "x", true},
		{"the longest allowed", strings.Repeat("a", RequestIDMaxLen), true},
		{"one over", strings.Repeat("a", RequestIDMaxLen+1), false},
		{"empty", "", false},
		{"a space", "two words", false},
		{"a newline", "first\nsecond", false},
		{"a carriage return", "first\rsecond", false},
		{"a tab", "first\tsecond", false},
		{"not ascii", "id-\xff-here", false},
		{"a dot", "service.request", false},
		{"a colon", "trace:1", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidRequestID(tt.id); got != tt.want {
				t.Errorf("ValidRequestID(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

// A minted id has to satisfy the reader on the other side of the boundary, which is ValidUUID.
func TestNewUUID(t *testing.T) {
	seen := make(map[string]bool, 256)

	for range 256 {
		id := NewUUID()
		if !ValidUUID(id) {
			t.Fatalf("NewUUID() = %q, which ValidUUID refuses", id)
		}
		if !ValidRequestID(id) {
			t.Fatalf("NewUUID() = %q, which cannot be carried as a request id", id)
		}
		if seen[id] {
			t.Fatalf("NewUUID() repeated %q", id)
		}
		seen[id] = true
	}
}

package contract

import (
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
		{"an offset, which z.iso.datetime() does not admit", "2026-09-06T16:43:21+02:00", true},
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

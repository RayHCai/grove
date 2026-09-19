package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixtures is the one directory every copy of these shapes is checked against. The vitest suite in
// libs/api-contract reads the same files with the zod schemas, so a member renamed on either side
// fails both suites rather than a join.
const fixtures = "../../api-contract/fixtures/wire"

// The json tags are the wire contract. Decoding and re-encoding a fixture byte for byte is what
// catches a rename, a reordered struct and a member one half grew and the other did not.
func TestWireShapesRoundTripTheirFixtures(t *testing.T) {
	tests := []struct {
		file string
		into func() any
	}{
		{"state-record.json", func() any { return &StateRecord{} }},
		{"state-write.json", func() any { return &StateWrite{} }},
		{"leaderboard-entry.json", func() any { return &LeaderboardEntry{} }},
		{"leaderboard-write.json", func() any { return &LeaderboardWrite{} }},
		{"leaderboard-page.json", func() any { return &LeaderboardPage{} }},
		{"bundle-set.json", func() any { return &BundleSet{} }},
		{"placement-request.json", func() any { return &PlacementRequest{} }},
		{"placement.json", func() any { return &Placement{} }},
		{"host-capacity.json", func() any { return &HostCapacity{} }},
		{"instance-report.json", func() any { return &InstanceReport{} }},
		{"instance-start.json", func() any { return &InstanceStart{} }},
		{"host-heartbeat.json", func() any { return &HostHeartbeat{} }},
		{"host-view.json", func() any { return &HostView{} }},
		{"fleet-event.json", func() any { return &FleetEvent{} }},
		{"fleet-report.json", func() any { return &FleetReport{} }},
		{"deployment-request.json", func() any { return &DeploymentRequest{} }},
		{"host-deployment.json", func() any { return &HostDeployment{} }},
		{"deployment.json", func() any { return &Deployment{} }},
	}

	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			want, err := os.ReadFile(filepath.Join(fixtures, tt.file))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			value := tt.into()
			if err := json.Unmarshal(want, value); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			got, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != string(want) {
				t.Errorf("wire shape drifted\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

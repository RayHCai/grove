package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// The router joins a player only to a world on the revision they fetched, so a survivor that came
// back without its revision is one no player could ever be sent to again.
func TestAnAdoptedChildKeepsItsRevision(t *testing.T) {
	dir := t.TempDir()
	launcher := newFakeLauncher()
	survivor := startN(t, registryOver(launcher, dir, 2), 1)[0]

	second := registryOver(launcher, dir, 2)
	if err := second.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	adopted, err := second.Get(survivor.InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if adopted.Revision != testRevision {
		t.Errorf("revision after the restart: got %d, want %d", adopted.Revision, testRevision)
	}

	second.Poll(context.Background())
	live := second.Live()
	if len(live) != 1 || live[0].Revision != testRevision || live[0].State != contract.InstanceHealthy {
		t.Errorf("the beat after the restart: got %+v, want the survivor healthy on revision %d", live, testRevision)
	}
}

// A record written before revisions were kept names a world no joiner can be matched to: it keeps
// its players and its slot, drains, and stays off the beat the router would refuse for it.
func TestASurvivorOfUnknownRevisionOnlyDrains(t *testing.T) {
	dir := t.TempDir()
	launcher := newFakeLauncher()
	survivor := startN(t, registryOver(launcher, dir, 2), 1)[0]

	path := filepath.Join(dir, survivor.InstanceID+stateExt)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the record: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode the record: %v", err)
	}
	delete(fields, "revision")
	old, _ := json.Marshal(fields)
	if err := os.WriteFile(path, old, 0o640); err != nil {
		t.Fatalf("write the old record: %v", err)
	}

	second := registryOver(launcher, dir, 2)
	if err := second.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	adopted, err := second.Get(survivor.InstanceID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if adopted.State != contract.InstanceDraining {
		t.Errorf("state: got %q, want draining", adopted.State)
	}
	if second.Running() != 1 {
		t.Errorf("running: got %d, want the survivor still counted", second.Running())
	}
	if live := second.Live(); len(live) != 0 {
		t.Errorf("the beat carried a world of unknown revision: %+v", live)
	}

	// Written down, so a third agent resumes the same drain rather than starting a new one.
	var rewritten record
	raw, _ = os.ReadFile(path)
	if err := json.Unmarshal(raw, &rewritten); err != nil || rewritten.DrainingSince.IsZero() {
		t.Errorf("the drain was not written down: %s", raw)
	}
}

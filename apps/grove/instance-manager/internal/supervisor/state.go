// What this box wrote down about the children it started, so the next run of this agent can find
// the ones the last one left running.

package supervisor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const stateExt = ".json"

// record is one child in the terms that outlive the agent that forked it: what the fleet calls it,
// and where on this box it is.
type record struct {
	InstanceID string    `json:"instanceId"`
	GameID     string    `json:"gameId"`
	SessionID  string    `json:"sessionId"`
	PID        int       `json:"pid"`
	Port       int       `json:"port"`
	StartedAt  time.Time `json:"startedAt"`
}

// store is the registry's memory across its own restart, one file per instance so a write cut short
// costs at most the record it was writing.
type store struct{ dir string }

func (s store) put(rec record) error {
	// An agent with nowhere to write remembers nothing, so a registry can be built with no disk
	// under it.
	if s.dir == "" {
		return nil
	}
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return fmt.Errorf("make %s: %w", s.dir, err)
	}

	raw, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("write down instance %s: %w", rec.InstanceID, err)
	}

	// Written beside and renamed over: a half-written record names a pid this agent would then
	// refuse to adopt, and the process it named would go unaccounted for.
	tmp := filepath.Join(s.dir, rec.InstanceID+".writing")
	if err := os.WriteFile(tmp, raw, 0o640); err != nil {
		return fmt.Errorf("write down instance %s: %w", rec.InstanceID, err)
	}
	if err := os.Rename(tmp, s.path(rec.InstanceID)); err != nil {
		return fmt.Errorf("write down instance %s: %w", rec.InstanceID, err)
	}
	return nil
}

func (s store) all() ([]record, error) {
	if s.dir == "" {
		return nil, nil
	}

	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", s.dir, err)
	}

	held := make([]record, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != stateExt {
			continue
		}

		var rec record
		raw, err := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		// A record this agent cannot read is one it cannot act on, and deleting it would throw away
		// the only trace of a process that may well still be running.
		if err != nil || json.Unmarshal(raw, &rec) != nil {
			continue
		}
		held = append(held, rec)
	}
	return held, nil
}

func (s store) drop(id string) error {
	if s.dir == "" {
		return nil
	}
	if err := os.Remove(s.path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("forget instance %s: %w", id, err)
	}
	return nil
}

func (s store) path(id string) string {
	return filepath.Join(s.dir, id+stateExt)
}

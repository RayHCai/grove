package env_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/env"
)

func TestAddr(t *testing.T) {
	if got := env.Addr("0.0.0.0", 4004); got != "0.0.0.0:4004" {
		t.Errorf("got %q", got)
	}
	// The bracket form, which a bare host:port concatenation would not produce.
	if got := env.Addr("::1", 4001); got != "[::1]:4001" {
		t.Errorf("got %q", got)
	}
}

func TestLogLevel(t *testing.T) {
	for _, c := range []struct {
		environment string
		want        slog.Level
	}{
		{"production", slog.LevelInfo},
		{"development", slog.LevelDebug},
		{"test", slog.LevelDebug},
	} {
		if got := env.LogLevel(c.environment); got != c.want {
			t.Errorf("%s: got %v, want %v", c.environment, got, c.want)
		}
	}
}

func TestLoggerIsParsableInProduction(t *testing.T) {
	var out bytes.Buffer
	env.Logger("production", &out).Info("serve", "requestId", "abc")

	var line map[string]any
	if err := json.Unmarshal(out.Bytes(), &line); err != nil {
		t.Fatalf("production logs must parse as JSON: %v", err)
	}
	if line["requestId"] != "abc" {
		t.Errorf("requestId: got %v", line["requestId"])
	}
}

func TestLoggerKeepsDebugOutsideProduction(t *testing.T) {
	var out bytes.Buffer
	env.Logger("development", &out).Debug("tick", "n", 1)

	if !strings.Contains(out.String(), "tick") {
		t.Errorf("a debug line must survive outside production, got %q", out.String())
	}
}

func TestLoggerDropsDebugInProduction(t *testing.T) {
	var out bytes.Buffer
	env.Logger("production", &out).Debug("tick", "n", 1)

	if out.Len() != 0 {
		t.Errorf("production must not carry debug lines, got %q", out.String())
	}
}

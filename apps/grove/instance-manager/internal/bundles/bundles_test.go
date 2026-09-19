package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

func hashOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// edge is the CDN a box pulls from, and a count of how many times it was actually asked.
type edge struct {
	server *httptest.Server
	hits   atomic.Int64
	bodies map[string]string
}

func newEdge(t *testing.T, bodies map[string]string) *edge {
	t.Helper()

	e := &edge{bodies: bodies}
	e.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.hits.Add(1)
		body, held := e.bodies[strings.TrimPrefix(r.URL.Path, "/")]
		if !held {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(e.server.Close)
	return e
}

func (e *edge) url(name string) string { return e.server.URL + "/" + name }

// set names two objects at the edge, under whatever hashes the caller wants them fetched as.
func (e *edge) set(t *testing.T, serverHash, configHash string) contract.BundleSet {
	t.Helper()

	return contract.BundleSet{
		Server: contract.BundleRef{
			Side: contract.SideServer, Hash: serverHash,
			URL: e.url("sim.js"), ByteLength: 4096,
		},
		Client: contract.BundleRef{
			Side: contract.SideClient, Hash: strings.Repeat("b", 64),
			URL: e.url("client.js"), ByteLength: 2048,
		},
		SimConfig: contract.ConfigRef{
			Hash: configHash, URL: e.url("sim.json"), ByteLength: 142,
		},
		SyncedHash: strings.Repeat("d", 64),
	}
}

func newDisk(t *testing.T) Disk {
	t.Helper()
	return Disk{Dir: t.TempDir(), Client: http.DefaultClient}
}

const (
	bundleBody = "globalThis.__grove = {};"
	configBody = `{"simRate":60,"sendRate":20}`
)

func TestFetchKeepsWhatItPulledUnderItsOwnHash(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.js": bundleBody, "sim.json": configBody})
	disk := newDisk(t)

	paths, err := disk.Fetch(context.Background(), e.set(t, hashOf(bundleBody), hashOf(configBody)))
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	for name, want := range map[string]string{paths.Bundle: bundleBody, paths.SimConfig: configBody} {
		held, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if string(held) != want {
			t.Fatalf("%s holds %q, want %q", name, held, want)
		}
	}
	// The name is the hash, so a second version of one game never lands on the first's file.
	if filepath.Base(paths.Bundle) != hashOf(bundleBody)+".js" {
		t.Fatalf("kept the bundle at %q, want it named by its hash", filepath.Base(paths.Bundle))
	}
}

// The client half is the browser's. A box that pulled it would spend bandwidth on bytes it never
// opens, once per version per box.
func TestFetchLeavesTheClientBundleAtTheEdge(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.js": bundleBody, "sim.json": configBody})
	disk := newDisk(t)

	if _, err := disk.Fetch(context.Background(), e.set(t, hashOf(bundleBody), hashOf(configBody))); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if hits := e.hits.Load(); hits != 2 {
		t.Fatalf("asked the edge %d times, want the two halves this box runs", hits)
	}
}

// Every session of one version after the first costs a stat, which is what makes a busy game cheap.
func TestASecondFetchOfOneVersionAsksTheEdgeNothing(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.js": bundleBody, "sim.json": configBody})
	disk := newDisk(t)
	set := e.set(t, hashOf(bundleBody), hashOf(configBody))

	first, err := disk.Fetch(context.Background(), set)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	before := e.hits.Load()

	second, err := disk.Fetch(context.Background(), set)
	if err != nil {
		t.Fatalf("second Fetch: %v", err)
	}
	if second != first {
		t.Fatalf("second Fetch: got %+v, want the paths the first landed at %+v", second, first)
	}
	if e.hits.Load() != before {
		t.Fatalf("asked the edge again: %d hits, want %d", e.hits.Load(), before)
	}
}

// Bytes that do not hash to the name they were fetched under are the wrong code, and a box that
// kept them would run it for every session of that version until an operator noticed.
func TestFetchRefusesBytesThatAreNotWhatTheyWereNamed(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.js": "not what was asked for", "sim.json": configBody})
	disk := newDisk(t)

	_, err := disk.Fetch(context.Background(), e.set(t, hashOf(bundleBody), hashOf(configBody)))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Fetch: got %v, want ErrCorrupt", err)
	}

	// Nothing kept, so the next start re-fetches rather than reading the bad bytes back as cached.
	entries, err := os.ReadDir(disk.Dir)
	if err != nil {
		t.Fatalf("read the cache: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("the cache holds %d files, want none of them the refused bytes", len(entries))
	}
}

func TestFetchRefusesAnEdgeThatWillNotAnswer(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.json": configBody})
	disk := newDisk(t)

	if _, err := disk.Fetch(context.Background(), e.set(t, hashOf(bundleBody), hashOf(configBody))); err == nil {
		t.Fatal("Fetch: got nil, want the 404 the edge answered")
	}
}

// The hash is the only part of a start that reaches this box's filesystem, so it is checked before
// it becomes a filename rather than after.
func TestFetchRefusesAHashThatIsNotOne(t *testing.T) {
	e := newEdge(t, map[string]string{"sim.js": bundleBody, "sim.json": configBody})
	disk := newDisk(t)

	for _, hash := range []string{"", "../../etc/passwd", strings.Repeat("A", 64), "abc"} {
		if _, err := disk.Fetch(context.Background(), e.set(t, hash, hashOf(configBody))); err == nil {
			t.Fatalf("Fetch with hash %q: got nil, want a refusal", hash)
		}
	}
	if e.hits.Load() != 0 {
		t.Fatal("asked the edge for an object whose name was refused")
	}
}

// A ceiling, because the length in a ref is a claim and the body is what actually arrives.
func TestFetchRefusesAnObjectPastTheCeiling(t *testing.T) {
	body := strings.Repeat("x", 1024)
	e := newEdge(t, map[string]string{"sim.js": body, "sim.json": configBody})
	disk := newDisk(t)
	disk.MaxBytes = 512

	if _, err := disk.Fetch(context.Background(), e.set(t, hashOf(body), hashOf(configBody))); err == nil {
		t.Fatal("Fetch: got nil, want a refusal past the ceiling")
	}
}

package supervisor

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/bundles"
	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// slowBundles is a first download from the edge: it finishes only when released, and counts how
// many downloads were started and whether any was cut short.
type slowBundles struct {
	release chan struct{}

	mu        sync.Mutex
	fetches   int
	cancelled bool
}

func (b *slowBundles) Fetch(ctx context.Context, _ contract.BundleSet) (bundles.Paths, error) {
	b.mu.Lock()
	b.fetches++
	b.mu.Unlock()

	select {
	case <-b.release:
		return bundles.Paths{Bundle: "/srv/bundles/sim.js", SimConfig: "/srv/bundles/sim.json"}, nil
	case <-ctx.Done():
		b.mu.Lock()
		b.cancelled = true
		b.mu.Unlock()
		return bundles.Paths{}, ctx.Err()
	}
}

func (b *slowBundles) count() (int, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.fetches, b.cancelled
}

// The router gives up on a cold start long before a first download ends. The download must outlive
// that start, and every start of the version in the meantime must wait on the same one.
func TestAColdFetchOutlivesTheStartThatAskedForIt(t *testing.T) {
	slow := &slowBundles{release: make(chan struct{})}
	launcher := newFakeLauncher()
	opts := testOptions(4)
	opts.Launcher = launcher
	opts.Prober = fakeProber{launcher: launcher}
	opts.Bundles = slow
	registry := New(opts)

	impatient, giveUp := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer giveUp()
	if _, err := registry.Start(impatient, request(0)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the impatient start: got %v, want its own deadline", err)
	}

	patient := make(chan error, 1)
	go func() {
		_, err := registry.Start(context.Background(), request(1))
		patient <- err
	}()

	waitFor(t, "the second start to be waiting", func() bool {
		registry.fetchMu.Lock()
		defer registry.fetchMu.Unlock()
		for _, f := range registry.fetching {
			return f.askers == 2
		}
		return false
	})
	close(slow.release)

	if err := <-patient; err != nil {
		t.Fatalf("the patient start: %v", err)
	}
	fetches, cancelled := slow.count()
	if fetches != 1 {
		t.Errorf("downloads: got %d, want one shared by both starts", fetches)
	}
	if cancelled {
		t.Error("the download was cut short when the start that began it gave up")
	}
	if launcher.count() != 1 {
		t.Errorf("processes: got %d, want only the start that waited", launcher.count())
	}
}

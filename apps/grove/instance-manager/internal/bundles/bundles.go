// Package bundles is the build output this box runs: fetched from the edge on the first session of
// a version, and kept on disk by content hash for every session after it.
package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// ErrCorrupt is a fetch whose bytes did not hash to the name they were asked for, which is the one
// failure that must never be cached: a box that kept it would run the wrong code until an operator
// noticed, and every session of that version would be wrong the same way.
var ErrCorrupt = errors.New("the bytes do not match the hash they were fetched under")

// Paths is where one version's code landed on this box, in the terms a child process is started
// with. The client half is deliberately absent: it is the browser's, and this box never runs it.
type Paths struct {
	Bundle    string
	SimConfig string
}

// Store is what a start needs on disk before a process can be forked.
//
// A seam because the suite must drive a corrupt download, a refused connection and a version
// already on the box without a network or an edge between them.
type Store interface {
	Fetch(ctx context.Context, set contract.BundleSet) (Paths, error)
}

// Disk keeps one file per content hash under Dir.
//
// Content-addressed rather than keyed by game and revision, so two games built from one template
// share a file and a redeploy that changed one half re-fetches only that half. It is also what makes
// the cache safe to keep: a name that is the hash of its own bytes can never be stale.
type Disk struct {
	Dir    string
	Client *http.Client
	// The largest object this box will pull. A bundle is single-digit megabytes; a length far past
	// that is a misconfigured edge or a redirect to something else entirely.
	MaxBytes int64
}

// The ceiling a Disk uses when none is configured.
const DefaultMaxBytes = 64 << 20

func (d Disk) Fetch(ctx context.Context, set contract.BundleSet) (Paths, error) {
	// The server half and the config, and nothing else: the client bundle is fetched by the browser
	// from the same edge, and a box that pulled it would spend bandwidth on bytes it never opens.
	bundle, err := d.file(ctx, set.Server.Hash, set.Server.URL, ".js")
	if err != nil {
		return Paths{}, fmt.Errorf("fetch the server bundle: %w", err)
	}
	config, err := d.file(ctx, set.SimConfig.Hash, set.SimConfig.URL, ".json")
	if err != nil {
		return Paths{}, fmt.Errorf("fetch the sim config: %w", err)
	}
	return Paths{Bundle: bundle, SimConfig: config}, nil
}

// file answers the path of one object, fetching it only if this box does not already hold it.
func (d Disk) file(ctx context.Context, hash, url, ext string) (string, error) {
	// Lowercase hex and nothing else, which is the contract's own spelling: a hash is a name, two
	// spellings of one name is two names, and this name becomes a path under Dir.
	if !contract.ValidContentHash(hash) {
		return "", fmt.Errorf("%q is not a sha-256", hash)
	}

	path := filepath.Join(d.Dir, hash+ext)
	// Held already, and the name is the hash of the bytes, so there is nothing to re-check.
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}

	if err := os.MkdirAll(d.Dir, 0o750); err != nil {
		return "", fmt.Errorf("make %s: %w", d.Dir, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build the fetch: %w", err)
	}

	client := d.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the edge answered %d for %s", res.StatusCode, hash)
	}

	// Written beside and renamed over, so a fetch cut short never leaves a short file under a name
	// the check above would then trust forever.
	tmp, err := os.CreateTemp(d.Dir, hash+".*.fetching")
	if err != nil {
		return "", fmt.Errorf("open a temporary file: %w", err)
	}
	// Removed on every path but the rename, which has already moved it by then.
	defer os.Remove(tmp.Name())

	digest := sha256.New()
	// Hashed as it is written rather than read back afterwards: the bytes cross this process once.
	copied, err := io.Copy(io.MultiWriter(tmp, digest), io.LimitReader(res.Body, d.maxBytes()+1))
	if err != nil {
		tmp.Close()
		return "", fmt.Errorf("read %s: %w", hash, err)
	}
	if copied > d.maxBytes() {
		tmp.Close()
		return "", fmt.Errorf("%s is larger than the %d bytes this box will fetch", hash, d.maxBytes())
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("write %s: %w", hash, err)
	}

	if hex.EncodeToString(digest.Sum(nil)) != hash {
		return "", fmt.Errorf("%w: %s", ErrCorrupt, hash)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", fmt.Errorf("keep %s: %w", hash, err)
	}
	return path, nil
}

func (d Disk) maxBytes() int64 {
	if d.MaxBytes < 1 {
		return DefaultMaxBytes
	}
	return d.MaxBytes
}

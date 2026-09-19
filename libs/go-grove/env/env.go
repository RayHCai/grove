// Package env reads the variables one service is configured with, and reports every problem at
// once.
package env

import (
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Reader accumulates what is wrong with an environment instead of failing on the first thing.
//
// A service with three unset variables must not need three restarts to learn that, which is why
// every method returns a usable value and records the problem for Err rather than raising it.
type Reader struct {
	vals  map[string]string
	probs []error
}

// New reads the process environment.
func New() *Reader {
	environ := os.Environ()
	vals := make(map[string]string, len(environ))
	for _, entry := range environ {
		if name, value, ok := strings.Cut(entry, "="); ok {
			vals[name] = value
		}
	}
	return &Reader{vals: vals}
}

// FromMap reads a fixed environment, which is what a test configures a service with.
func FromMap(m map[string]string) *Reader {
	return &Reader{vals: maps.Clone(m)}
}

// String returns the variable, or fallback when it is unset.
func (r *Reader) String(name, fallback string) string {
	if value, ok := r.lookup(name); ok {
		return value
	}
	return fallback
}

// Required returns the variable. There is no fallback: an unset one is a wiring fault, not a gap.
func (r *Reader) Required(name string) string {
	value, ok := r.lookup(name)
	if !ok {
		r.miss(name)
	}
	return value
}

// Int returns the variable parsed as a base-ten integer, or fallback when it is unset.
func (r *Reader) Int(name string, fallback int) int {
	value, ok := r.lookup(name)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		r.fail(fmt.Errorf("%s must be an integer: %w", name, err))
		return fallback
	}
	return parsed
}

// Port reads a listening port, refusing what a listener would silently accept.
//
// Zero is the trap this exists for: `net.Listen` reads it as "any free port", so a service given
// one comes up healthy on an address nothing in the fleet routes to.
func (r *Reader) Port(name string, fallback int) int {
	port := r.Int(name, fallback)
	if port < 1 || port > 65535 {
		r.fail(fmt.Errorf("%s must be a port between 1 and 65535, got %d", name, port))
		return fallback
	}
	return port
}

// Duration returns the variable parsed the way Go writes one — "30s", "5m" — or fallback when
// unset.
func (r *Reader) Duration(name string, fallback time.Duration) time.Duration {
	value, ok := r.lookup(name)
	if !ok {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		r.fail(fmt.Errorf("%s must be a duration: %w", name, err))
		return fallback
	}
	return parsed
}

// Secret returns the variable as key material, and never names its value in an error.
func (r *Reader) Secret(name string, minLen int) []byte {
	value, ok := r.lookup(name)
	if !ok {
		r.miss(name)
		return nil
	}
	if len(value) < minLen {
		r.fail(fmt.Errorf("%s must be at least %d characters", name, minLen))
		return nil
	}
	return []byte(value)
}

// URL returns the variable, required to be absolute — which is all `z.url()` asks on the other
// side.
func (r *Reader) URL(name string) string {
	value, ok := r.lookup(name)
	if !ok {
		r.miss(name)
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		r.fail(fmt.Errorf("%s must be a url: %w", name, err))
		return value
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		r.fail(fmt.Errorf("%s must be an absolute url, got %q", name, value))
	}
	return value
}

// OneOf returns the variable when it is one of allowed, or fallback when it is unset.
func (r *Reader) OneOf(name string, fallback string, allowed ...string) string {
	value, ok := r.lookup(name)
	if !ok {
		return fallback
	}
	if slices.Contains(allowed, value) {
		return value
	}
	r.fail(fmt.Errorf("%s must be one of %s, got %q", name, strings.Join(allowed, ", "), value))
	return fallback
}

// Err reports every problem in one error, in the order the service asked for the variables.
func (r *Reader) Err() error {
	if len(r.probs) == 0 {
		return nil
	}
	return fmt.Errorf("bad environment:\n%w", errors.Join(r.probs...))
}

// A variable exported as the empty string has said nothing, so it reads as unset.
func (r *Reader) lookup(name string) (string, bool) {
	value := strings.TrimSpace(r.vals[name])
	return value, value != ""
}

func (r *Reader) miss(name string) {
	r.fail(fmt.Errorf("%s is required", name))
}

func (r *Reader) fail(err error) {
	r.probs = append(r.probs, err)
}

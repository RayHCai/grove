package env

import (
	"io"
	"log/slog"
	"net"
	"strconv"
)

// SecretMinLen is the floor every service holds its key material to, and the one
// `apps/grove/api/src/env.ts` states on the TypeScript side. A service that accepted a shorter key
// than the one minting the tokens it verifies would be the weak end of a pair.
const SecretMinLen = 32

// Addr is what a listener binds, from the host and port a config read.
func Addr(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// Environment is GROVE_ENV, the one variable every service reads the same way.
func (r *Reader) Environment() string {
	return r.OneOf("GROVE_ENV", "development", "development", "test", "production")
}

// PlatformPort is the PORT a host such as Railway assigned, or fallback, and whether one was assigned.
func (r *Reader) PlatformPort(fallback int) (port int, hosted bool) {
	_, hosted = r.lookup("PORT")
	return r.Port("PORT", fallback), hosted
}

// logLevel is debug everywhere a person is watching, and info where a log aggregator is.
func logLevel(environment string) slog.Level {
	if environment == "production" {
		return slog.LevelInfo
	}
	return slog.LevelDebug
}

// Logger is the one construction every service in the fleet logs through: JSON where an aggregator
// parses it, text where a person reads it. One function rather than one per main, because
// `httpx` tags every request and panic line with `requestId` and a service that dropped that field
// into an unparsed format is one the fleet's logs cannot be joined across.
func Logger(environment string, out io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{Level: logLevel(environment)}
	if environment == "production" {
		return slog.New(slog.NewJSONHandler(out, opts))
	}
	return slog.New(slog.NewTextHandler(out, opts))
}

# @grove/go-grove

The environment reader, the HTTP layer, the session-token codec and the wire shapes that
`@grove/game-manager`, `@grove/server-manager` and `@grove/instance-manager` share.

The Go half of what `@grove/api-contract` is for the TypeScript services: one declaration of a shape
both ends of a call agree on, so a Go handler and the Fastify route talking to it cannot disagree
about a field name.

`env` accumulates every problem with a process's configuration and reports them in one error, the
way the TypeScript services print `z.prettifyError`. A service with three unset variables does not
need three restarts to learn that.

`httpx` is the one error body, the JSON codec on either side of a handler, the wraps around it, and
the listener that drains what is in flight on the way down. Its status-to-code mapping is the one in
`apps/grove/api/src/errors.ts`, so a single client parser covers the fleet, and a 5xx flattens to
`internal error` rather than handing a caller this end's internals. The outermost wrap reads
`X-Request-Id`, bounds it to one token a log can hold, mints a fresh one where the caller's is not,
echoes it back, and tags the request and panic lines with `requestId`; `Forward` puts the same id on
an outbound call, so one request is one id across every service it touches. `Ready` answers the
readiness poll against a probe the service supplies, since what readiness means is the service's to
say, and reports 503 when the probe fails. The listener sets read, write and idle deadlines, so no
caller holds a connection for free, and a route that legitimately takes longer sets its own with
`http.ResponseController`.

`token` mints and verifies the join ticket byte for byte as `libs/api-contract/src/session-token.ts`
does. A codec written twice is a codec that drifts, so the format is pinned at both ends: unpadded
base64url of the compact claims JSON, a dot, then the HMAC-SHA256 of that payload. The signature is
checked before the payload is parsed, so a forged one never reaches a decoder.

`contract` mirrors the zod schemas — the id and content-hash checks, and the structs the Go services
exchange with the TypeScript ones, with json tags matching character for character. A timestamp
crosses as the RFC 3339 string `z.iso.datetime()` reads, so a struct here carries a `string` rather
than a `time.Time`.

The standard library and nothing else. No framework, no router, no third-party dependency of any
kind: `go.sum` stays empty, the build works offline, and routing is `net/http` pattern matching. This
module is what a service imports — it holds no route, no store and no service of its own.

The three services list this package in their `package.json` as well as in `go.mod`. Turbo builds
its graph from the package manager's and cannot read a `require` line, so without that
`workspace:*` edge an edit here invalidates nothing downstream and a service's test restores from a
cache that predates the change.

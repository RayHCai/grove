# @grove/go-grove

The environment reader, the HTTP layer, the Ed25519 token codec and the wire shapes that
`@grove/game-manager`, `@grove/server-manager` and `@grove/instance-manager` share.

The Go half of what `@grove/api-contract` is for the TypeScript services: one declaration of a shape
both ends of a call agree on, so a Go handler and the Fastify route talking to it cannot disagree
about a field name.

`env` accumulates every problem with a process's configuration and reports them in one error, the
way the TypeScript services print `z.prettifyError`. A service with three unset variables does not
need three restarts to learn that. It also holds the decisions every service's `config`
package would otherwise each make for itself: `SecretMinLen`, the floor key material is held to and
the one `apps/grove/api/src/env.ts` states; `Environment`, the one reading of `GROVE_ENV`;
`PlatformPort`, the `PORT` a host such as Railway assigns and whether it assigned one; `Refuse`,
which reports a variable a service parsed itself among the rest; `Addr`,
which joins a host and a port into what a
listener binds; and `Logger`, the one construction the fleet logs through: JSON where an aggregator
parses it, text where a person reads it, debug everywhere but production. One logger rather than one
per `main`, because `httpx` tags every request and panic line with `requestId` and a service that
dropped that field into an unparsed format is one the fleet's logs cannot be joined across.

`httpx` is the one error body, the JSON codec on either side of a handler, the wraps around it, and
the listener that drains what is in flight on the way down. Its codes are the ones in
`libs/service-kit/src/errors.ts`, so a single client parser covers the fleet, and a 5xx flattens to
`internal error` rather than handing a caller this end's internals. The outermost wrap reads
`X-Request-Id`, bounds it to one token a log can hold, mints a fresh one where the caller's is not,
echoes it back, and tags the request and panic lines with `requestId`; `Forward` puts the same id on
an outbound call, so a service reached that way logs under the one its caller did. `SharedSecret`
is the gate a route sits behind, admitting any one of the credentials it is given, each compared in
constant time, so a route names exactly which pair of services may call it, and `FleetClient` is the
calling end: one JSON call under that bearer, with the request id forwarded, the answer read to a
bound, and a refused status returned as a `StatusError`. `Service` assembles every service's handler the same
way: `/health` and `/ready` open, one `/v1` scope behind the gate it is given with the shared 404
inside it, and the wraps in the order request id, access log, panic net, so a panic's 500 still
gets its access line. `RateLimit` sweeps idle keys until the context it was built with ends. `Ready` answers
the readiness poll against a probe the service supplies, since what readiness means is the service's
to say, and reports 503 when the probe fails. The listener sets read, write and idle deadlines, so no
caller holds a connection for free, and a route that legitimately takes longer sets its own with
`http.ResponseController`. `ServeAll` binds several listeners before serving any and drains them
together; each is plaintext or serves the TLS `CertFiles` loads, which re-reads a renewed pair
without a restart, and each may cap its connections, refusing past the cap at accept.

`token` mints and verifies the fleet's Ed25519 credentials in the format
`libs/api-contract/src/session-token.ts` signs join tickets in, pinned at both ends because a codec
written twice drifts: unpadded base64url of the compact claims JSON, a dot, then the signature over
that first segment. Each segment has one canonical spelling, a verifier holds a list of public keys
so a signer rotates by adding its new key everywhere first, and the signature is checked before the
payload is parsed. `@grove/server-manager` signs each world's store bearer with it and
`@grove/game-manager` verifies them, so no box holds a key that signs one.

`contract` mirrors the zod schemas: the id and content-hash checks, and the structs the Go services
exchange with the TypeScript ones, with json tags matching character for character. A timestamp
crosses as the RFC 3339 string `z.iso.datetime()` reads, so a struct here carries a `string` rather
than a `time.Time`. `BundleSet.Problem` is the one bundle-set check, applied by the router and the
box alike, so a set one of them passed is never one the other refuses; `ValidHost` is the one rule
for the name a url to a box may carry, and `UTF16Len` counts a string the way a zod bound does.

The standard library and nothing else. No framework, no router, no third-party dependency of any
kind: `go.sum` stays empty, the build works offline, and routing is `net/http` pattern matching. This
module is what a service imports; it holds no route, no store and no service of its own.

The three services list this package in their `package.json` as well as in `go.mod`. Turbo builds
its graph from the package manager's and cannot read a `require` line, so without that
`workspace:*` edge an edit here invalidates nothing downstream and a service's test restores from a
cache that predates the change.

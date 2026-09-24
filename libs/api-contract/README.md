# @grove/api-contract

The request and response shapes both services validate against, and the session token one mints and
the other verifies.

One declaration per shape, so a route and the code calling it cannot disagree. `@grove/api` mounts
these as Fastify schemas through the zod type provider, which makes them the validator, the
serializer, and the OpenAPI document at once, and `@grove/game-builder` parses the same shapes back
off the wire.

The key layout of the games bucket is here for the same reason a shape is: `@grove/api` writes those
keys and `@grove/game-builder` reads them, and a prefix spelled twice is a prefix that drifts. So is
the name of each task stream, which one service pushes to and another claims from.

The Go services carry the same shapes in `libs/go-grove`, whose `contract` package is written against
this one field for field, and the two Rust crates carry hand-written serde mirrors of the few shapes
they touch. Where any of them disagree, this package is the claim and the others are copies. What
pins a copy is a fixture and not a compiler: the token by a frozen vector the signer and both
verifiers are run against, and the wire shapes by JSON documents the zod suite parses back unchanged
and the Go suite re-encodes byte for byte.

The token belongs here for the same reason the schemas do: it is signed by one service and checked
by another, and a codec written twice is a codec that drifts. Its claims carry `gameId`, so a
request cannot name a game its token did not, and `aud`, so the credential a browser holds for a
game process is not also one the data plane accepts.

`./client` is a third subpath, for the opposite reason `./tokens` is one: `@grove/editor` and
`@grove/platform` each held a byte-identical `fetch` wrapper — the CSRF header, the credentials, the
JSON body, and one shared answer to "did the session lapse" — and a wrapper written twice is exactly
the kind of copy this package exists to prevent. It reaches only the global `fetch`, so it is behind
no more of a wall than the shapes themselves are.

The password floor and ceiling are here too, as `PASSWORD_MIN` and `PASSWORD_MAX`: the one rule a
sign-up form's hint and the server's own validation both state, so a form that mirrors the floor and
forgets the ceiling is a form this package no longer lets happen.

The correlation header is here for the same reason, though it is neither a shape nor a signature:
`libs/go-grove/contract` declares the same name and the same bound, and one half of the fleet keeping
an id the other would have replaced is a chain that breaks at whichever hop is stricter.

Zod and `node:crypto` — no Fastify, no HTTP client, nothing that would stop a game process from
taking this package.

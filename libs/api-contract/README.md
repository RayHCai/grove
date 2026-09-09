# @grove/api-contract

The request and response shapes both services validate against, and the session token one mints and
the other verifies.

One declaration per shape, so a route and the code calling it cannot disagree. `@grove/api` and
`@grove/game-builder` mount these as Fastify schemas through the zod type provider, which makes them
the validator, the serializer, and the OpenAPI document at once. `@grove/game-instance` imports the
same objects to parse what it gets back, which is what a typed client would otherwise have to
generate.

The Go services carry the same shapes in `libs/go-grove`, whose `contract` package is written against
this one field for field. Where the two disagree, this package is the claim and that one is the copy.

The token belongs here for the same reason the schemas do: it is signed by one service and checked
by another, and a codec written twice is a codec that drifts. Its claims carry `gameId`, so a
request cannot name a game its token did not.

Zod and `node:crypto` — no Fastify, no HTTP client, nothing that would stop a game process from
taking this package.

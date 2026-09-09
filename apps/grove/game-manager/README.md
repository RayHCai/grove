# @grove/game-manager

Game data for running sessions: `@serverState`, leaderboards, and the bundles a session loads.
Written in Go.

The only thing between a game process and the database. It holds the credential a game process does
not: a game presents a session-scoped token and reaches its own game's rows through here, and there
is no other way in. Not publicly routable.

## The scope, and what it makes impossible

Every route under `/v1` sits behind one token-verifying middleware, and `gameId` comes off the
verified claims onto the request context. No handler reads it from a URL, because there is no URL to
read it from — a request cannot name a game its token was not issued for, so cross-game access is
unrepresentable rather than merely rejected. A route added to the scope is authenticated because of
where it is registered, not because someone remembered to check.

`/health` and `/ready` sit outside that scope: the local `@grove/instance-manager` polls them before
any token exists.

| Route                                       | Answers                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| `GET /health`                               | `{"ok":true}`                                         |
| `GET /ready`                                | `{"ok":true}` once the store answers, or 503          |
| `GET /v1/state/{key}`                       | the record, or 404                                    |
| `PUT /v1/state/{key}`                       | the revision the write landed on, or 409              |
| `GET /v1/leaderboard?board=&limit=&cursor=` | one page, `limit` defaulting to 25 and clamped to 100 |
| `GET /v1/bundles`                           | the set this game's sessions load, or 404             |

A write carrying `ifRevision` is a compare-and-set, and a stale one is a 409 that leaves the value
where it was: two ticks racing on one key is a bug the caller has to see, not one to paper over. A
key never written is at revision zero, which is what makes the first compare-and-set of a key
expressible as `ifRevision: 0` rather than a special case a caller has to know about.

## The store

`internal/store` is one interface — `Ping`, `Read`, `Write`, `Leaderboard`, `Bundles` — and every
method that reaches a row takes the game as its first argument rather than reading one from a
request. `main.go` chooses the implementation, which is the one place a real database lands.

The bundles themselves are fetched from the urls `GET /v1/bundles` returns, never through here: a
service that proxied multi-megabyte chunks would be on the join path for every player of every game.

## The rate limit

600 requests a minute, keyed by the game the token was verified to name. Every caller sits behind
the same fleet network, so an address key would be one bucket for the whole host — and a key read
from the header ahead of the check is one a caller mints per request, which is a fresh bucket per
request. So the limiter sits inside the scope, behind the token check rather than in front of it.

## The failure shape

`{ "code": ..., "message": ... }` from `@grove/go-grove`'s `httpx`, with the status-to-code mapping
`@grove/api` uses, so one client parser covers both services. A 5xx flattens to `internal error` —
a handler's internals never reach a caller.

## Running it

```bash
pnpm --filter @grove/game-manager run build
./dist/game-manager
```

| Variable            | What                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `GAME_MANAGER_HOST` | address to bind, `127.0.0.1` by default                                |
| `GAME_MANAGER_PORT` | port to bind, `4001` by default                                        |
| `GAME_TOKEN_SECRET` | shared with `@grove/api`, which mints the tokens this service verifies |
| `GROVE_ENV`         | `development`, `test` or `production`; the log level follows it        |

Loopback by default because this service is reachable from the fleet's own network and from nowhere
else, and a default of `0.0.0.0` is how that stops being true by accident. Every problem with that
environment is reported in one error, so a process with three unset variables does not need three
restarts to learn that.

`pnpm run build | test | typecheck` at the repo root reach this module through `package.json`, whose
scripts shell to `go`, and `typecheck` to `staticcheck` after it — a separate binary a machine can
lack while it has Go. Either one missing from `PATH` prints one `skipped:` line and succeeds, so
working on the TypeScript half of the fleet does not require installing Go; CI names both in
`GROVE_REQUIRE_TOOLCHAIN`, where their absence is a broken install and fails the gate instead.

The standard library and `@grove/go-grove`, and nothing else. Routing is `net/http` pattern matching,
so `go.sum` stays empty and the build works offline.

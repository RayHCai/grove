# @grove/game-builder

Compiles a creator's source into the bundle set a session loads.

A caller on the fleet's own network queues a build here and polls the job for its outcome. This
service holds no database credential and is not publicly routable: a caller presents the shared
fleet bearer rather than a session token, and nothing with an origin talks to it.

`buildApp` is handed the queue it serves, and that queue is handed the `Compiler` it runs, so what
compiles a build is chosen where the process starts. `main.ts` has no `Compiler` to hand it, and
refuses to start rather than answer a build it could only fail.

A build is queued, never run on the request. One `POST /v1/builds` costs minutes of a build box's
CPU, so the reply is a place in line and the creator's editor polls the job for the rest — a failed
one carries the diagnostics that editor renders in its gutter, and a failure of the box itself is
reported against `build` rather than against the creator's source. One build runs at a time, and the
queue is handed the deadline it gives a compile up at, so nothing holds that slot indefinitely.
A job lives in the memory of the box that accepted it: another builder, or the same one restarted,
answers a poll with `404`, and a settled record is dropped an hour later, at the next build the box
finishes.

## The environment

Nothing is defaulted quietly except where the default is the safe one, so a missing value fails at
startup rather than at the first request that needed it.

| Variable            | What                                                            |
| ------------------- | --------------------------------------------------------------- |
| `NODE_ENV`          | `development`, `test` or `production`; sets the log level       |
| `GAME_BUILDER_HOST` | address to bind, `127.0.0.1` by default                         |
| `GAME_BUILDER_PORT` | `4002` by default                                               |
| `FLEET_SECRET`      | the shared bearer every caller presents, at least 32 characters |
| `BUILD_TIMEOUT_MS`  | how long one compile may hold the slot, 15 minutes by default   |

Loopback by default for the same reason `@grove/game-manager` binds there: this service is reachable
from the fleet's own network and from nowhere else, and a default of `0.0.0.0` is how that stops
being true by accident.

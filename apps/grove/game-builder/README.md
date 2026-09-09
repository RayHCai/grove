# @grove/game-builder

Compiles a creator's source into the bundle set a session loads.

`@grove/api` takes the upload and queues a build here; this service compiles it, stores the
artifacts in `@grove/upload-service`, and registers the resulting bundle set with
`@grove/game-manager`. It holds no database credential and is not publicly routable: a caller
presents the shared fleet bearer rather than a session token, and nothing with an origin talks to
it.

A build is queued, never run on the request. One `POST /v1/builds` costs minutes of CPU across a
child `tsc` and a bundler, so the reply is a place in line and the creator's editor polls the job
for the rest — a failed one carries the diagnostics that editor renders in its gutter.

## The environment

Nothing is defaulted quietly except where the default is the safe one, so a missing value fails at
startup rather than at the first request that needed it.

| Variable             | What                                                            |
| -------------------- | --------------------------------------------------------------- |
| `NODE_ENV`           | `development`, `test` or `production`; sets the log level       |
| `GAME_BUILDER_HOST`  | address to bind, `127.0.0.1` by default                         |
| `GAME_BUILDER_PORT`  | `4002` by default                                               |
| `FLEET_SECRET`       | the shared bearer every caller presents, at least 32 characters |
| `UPLOAD_SERVICE_URL` | where the source is read from and the artifacts are written     |
| `GAME_MANAGER_URL`   | where a finished bundle set is registered                       |

Loopback by default for the same reason `@grove/game-manager` binds there: this service is reachable
from the fleet's own network and from nowhere else, and a default of `0.0.0.0` is how that stops
being true by accident.

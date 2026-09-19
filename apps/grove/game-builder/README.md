# @grove/game-builder

Compiles a creator's source into the bundle set a session loads.

Nothing calls this service. It claims its work from a Redis stream and settles it against
`@grove/api`, presenting the shared fleet bearer; it holds no database credential, is not publicly
routable, and nothing with an origin talks to it. The one route it serves is the health endpoint a
host agent polls.

A consumer group rather than a list, because a box that dies mid-build has to hand its claim back
instead of taking the build with it: `XAUTOCLAIM` is what another box reclaims through, and the
window is `BUILD_TIMEOUT_MS`, because a compile legitimately holds a claim for minutes. Two boxes
sharing a consumer name share their claims, which is why `BUILDER_NAME` falls back to the hostname
rather than to a value every box would write the same.

A claimed message carries a task id and nothing else. What tells this box what to build is the
answer to its own claim — `PATCH /v1/tasks/:taskId` hands back the task, and with it the game and the
manifest revision it is pinned to. That is deliberate: the row is the truth, and a message that has
been sitting in a stream for ten minutes is not. The manifest at that revision is immutable once
written, so a build queued minutes ago still compiles exactly the set the creator pressed the button
on.

A message is acknowledged once the outcome is written down, whatever the outcome was. A claim that
was refused is work somebody already settled — acknowledged, or it comes back forever. A claim or an
outcome that could not be written at all is left claimed, so another box takes it back after the
reclaim window: acknowledging there would leave a creator watching a task nothing will ever move. A
manifest that cannot be read fails the task against the box rather than against a creator's file,
with no diagnostic, because nothing in their source can make a manifest unreadable.

`main.ts` starts the consumer and the health endpoint. A box with no stream or no bucket behind it
still comes up and says so in the log: one that refuses to boot is one no host agent can tell apart
from a box that is gone.

## The environment

Nothing is defaulted quietly except where the default is the safe one, so a missing value fails at
startup rather than at the first task that needed it.

| Variable            | What                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`          | `development`, `test` or `production`; sets the log level                         |
| `GAME_BUILDER_HOST` | address to bind, `127.0.0.1` by default                                           |
| `GAME_BUILDER_PORT` | `4002` by default                                                                 |
| `FLEET_SECRET`      | the bearer this service presents settling a task, at least 32 characters          |
| `API_URL`           | where a task is settled, which is the only call this service makes                |
| `REDIS_URL`         | the stream builds are claimed from; absent, this process has no work to do        |
| `GAMES_BUCKET`      | the bucket a manifest is read from; absent, a claimed build can only fail         |
| `AWS_REGION`        | the bucket's region, `us-east-1` by default                                       |
| `S3_ENDPOINT`       | set only where something other than AWS answers for the bucket, such as MinIO     |
| `BUILDER_NAME`      | this box's name in the consumer group; the hostname when it is not set            |
| `BUILD_TIMEOUT_MS`  | how long a claim is held before another box may reclaim it, 15 minutes by default |

Loopback by default for the same reason `@grove/game-manager` binds there: this service is reachable
from the fleet's own network and from nowhere else, and a default of `0.0.0.0` is how that stops
being true by accident.

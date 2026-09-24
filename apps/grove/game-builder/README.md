# @grove/game-builder

Claims a creator's build off the queue, compiles it, and settles it.

Nothing calls this service. It claims its work from a Redis stream and settles it against
`@grove/api`, presenting the shared fleet bearer; it holds no database credential and no bucket
credential, is not publicly routable, and nothing with an origin talks to it. The one route it
serves is the health endpoint a host agent polls.

The stream sits in the database `@grove/api-contract` names for `BUILD`, which is not the one asset
uploads use. The number is the contract's rather than the connection string's, so a box handed the
fleet's one Redis URL still reads the database its own kind of work was pushed to, and an operator
reaching for a database reaches one kind of work at a time.

A consumer group rather than a list, because a box that dies mid-build has to hand its claim back
instead of taking the build with it: `XAUTOCLAIM` is what another box reclaims through, and the
window is `BUILD_TIMEOUT_MS`. That window is sized for an infrastructure failure to be noticed
rather than for the compile, which is a handful of modules and under a minute. Two boxes sharing a
consumer name share their claims, which is why `BUILDER_NAME` falls back to the hostname rather than
to a value every box would write the same.

A claimed message carries a task id and nothing else. What tells this box what to build is the
answer to its own claim — `PATCH /v1/tasks/:taskId` hands back the task, and with it the game and the
manifest revision it is pinned to. That is deliberate: the row is the truth, and a message that has
been sitting in a stream for ten minutes is not.

## What one build does

A build is atomic. There is no resuming a half-finished one: the work is seconds, and the
bookkeeping that would let a second box pick up where a dead one stopped costs more than starting
again.

Everything it reads and writes goes through `@grove/api`, which is what the missing bucket
credential buys. It fetches the manifest that revision froze, then each **source** file at the
version that manifest named — never what is current at the key, so an edit made after the publish
cannot reach the compiler. Assets are passed over: their bytes are fetched by a client from the
edge, and what a compile needs of one is the record in the project manifest.

A creator writes no imports — the workbench declares the engine as globals — so the import is put
back above each file from `@platform/scripting`'s own list, the same one the editor compiles
against. It shares the file's first line rather than taking one of its own, because every position
this service reports is read off the file it handed the compiler.

Then `@platform/scripting/toolchain`, in the order that package fixes and this one does not change:

| Pass        | Refuses                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| analyse     | a script class the manifest names and the source does not export                |
| determinism | the `Math` members, `Date`, `fetch`, `eval` and the rest, inside a synced class |
| `tsc`       | anything that does not typecheck                                                |
| rolldown    | a script module that imports dynamically, and two classes claiming one id       |

Out come two chunks, which are then rolled into the two files that are actually evaluated. Nothing
is left external in either: the client half is imported from a blob URL in a browser and the server
half is evaluated by an isolate with no module loader, and neither can answer a bare specifier. A
second copy of `@platform/core` riding along is harmless, because every table core keeps is found
through a registered symbol.

Four files land under `build/<revision>/`, in this order and for this reason:

| File             | Is                                                               |
| ---------------- | ---------------------------------------------------------------- |
| `client.js`      | the module a joining browser fetches and evaluates               |
| `simConfig.json` | the rates a host reads, and the client half's address and digest |
| `server.js`      | the classic script a session's isolate evaluates                 |
| `build.json`     | the `BuildManifest` naming all three                             |

The client half is first because what it hashes to is what every joiner is held to at the
handshake, and the config naming that hash cannot be written before it exists. `build.json` is last
and is the commit marker: nothing reads the other three until one names them, so a box that died
mid-build leaves chunks nobody fetches rather than a half-built version a player can be sent at.

Neither the address nor the digest is this box's to invent. `@grove/api` answers both when it stores
a file, because it is the one place that knows where the edge serves that bucket from.

## Two kinds of failure, and why the difference matters

Source this build refuses — a `SyncedScript` reading `Date.now()`, a type error, a manifest naming
a class that is not there — is `FAILED`, with diagnostics positioned the way a creator's editor
gutters them, and it is never retried. Nothing about a second attempt would go differently.

The fleet failing — a bucket that would not answer, a compiler that could not be started, this box
running out of disk — leaves the message claimed for another box to take back.

Getting that line wrong is worse now than it was: a whole-build restart means a creator error
mistaken for infrastructure is a game rebuilt forever. `BUILD_ATTEMPTS` is the ceiling, counted on
the row rather than in this process, so a fault that looks transient on every box in turn still
stops — and the build is then `FAILED` with what went wrong, rather than left for a creator to watch.

A message is acknowledged once the outcome is written down, whatever the outcome was. A claim that
was refused is work somebody already settled — acknowledged, or it comes back forever. A claim or an
outcome that could not be written at all is left claimed, so another box takes it back after the
reclaim window: acknowledging there would leave a creator watching a task nothing will ever move.

`main.ts` starts the consumer and the health endpoint. A box with no stream behind it still comes up
and says so in the log: one that refuses to boot is one no host agent can tell apart from a box that
is gone.

| File          | Holds                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| `main.ts`     | the composition root: the environment, the consumer, the health endpoint |
| `consumer.ts` | the stream, and what one claimed task does end to end                    |
| `compile.ts`  | the work tree, the toolchain, and the two files that come out of it      |
| `store.ts`    | the source a build reads and the output it writes, through `@grove/api`  |
| `tasks.ts`    | the status route a claimed task is settled through                       |

A build's work tree is put together under `.builds/` **inside this package**, and that is not a
preference: `tsc` and both bundlers resolve `@platform/*` by walking up from the file that imports
it, so a creator's module has to sit where those walks reach this service's own `node_modules`. The
tree is removed whatever the outcome.

## The environment

Nothing is defaulted quietly except where the default is the safe one, so a missing value fails at
startup rather than at the first task that needed it.

| Variable            | What                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`          | `development`, `test` or `production`; sets the log level                        |
| `GAME_BUILDER_HOST` | address to bind, `127.0.0.1` by default                                          |
| `GAME_BUILDER_PORT` | `4002` by default                                                                |
| `FLEET_SECRET`      | the bearer this service presents reading source, storing output and settling     |
| `API_URL`           | where all three of those happen, which is the only service this one calls        |
| `REDIS_URL`         | the server builds are claimed from; absent, this process has no work to do       |
| `BUILDER_NAME`      | this box's name in the consumer group; the hostname when it is not set           |
| `BUILD_TIMEOUT_MS`  | how long a claim is held before another box may reclaim it, 3 minutes by default |
| `BUILD_ATTEMPTS`    | how many boxes may try one build before it is settled as failed, 3 by default    |

A database named in `REDIS_URL` is ignored: the contract decides which one this box reads.

Loopback by default for the same reason `@grove/game-manager` binds there: this service is reachable
from the fleet's own network and from nowhere else, and a default of `0.0.0.0` is how that stops
being true by accident.

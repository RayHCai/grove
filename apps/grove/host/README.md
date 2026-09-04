# @grove/host

One game session, in one process: the sockets, the ticket check, the tick clock, the isolate the
world runs in, and the drain. Written in Rust.

The process boundary is the outer isolation and the V8 isolate is the inner one. This process holds
no database credential and no platform secret — a shared secret it verifies join tickets with, and a
session-scoped bearer for `@grove/game-manager`, which is the only store it can reach.

## The two halves, and why they never share a thread

`tokio` owns the listener, one task per peer, and the store. One dedicated thread owns the V8
isolate. They meet at a single channel of `HostEvent`, and that is what gives a tick one order over
everything that happened to it — a `deno_core` `JsRuntime` is not `Send`, and a tick that could be
moved mid-step would not be a fixed step at all.

| File          | Holds                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `main.rs`     | the composition root: config, listener, the drain signal, the session thread    |
| `config.rs`   | the environment `@grove/server-manager` spawns this process with                |
| `ticket.rs`   | join-ticket verification, byte for byte with `libs/api-contract`'s minting      |
| `net.rs`      | the WebSocket listener, one task per peer, and the frame-size cap               |
| `session.rs`  | the tick loop, the write-out, and the watchdog that kills a runaway tick        |
| `isolate.rs`  | the V8 isolate, the two ops a batch crosses in, and the heap limit              |
| `clock.rs`    | the accumulator, the step cap and shed, and the send cadence                    |
| `protocol.rs` | the batch types, mirroring `packages/sim/src/batch.ts` field for field          |
| `store.rs`    | `@serverState` over `@grove/game-manager`, which is the only thing it can reach |

## What it does not own

The world. Everything from a decoded inbound frame to an outbound envelope is `@platform/sim`'s —
the narrowing, admission, the input buffer, the join, the snapshot, the drain of the replication
channels. This half never learns what an entity is, which is what lets the same sim run in a browser
for prediction with no host at all.

Its in-process twin is `@platform/glue`'s `GameInstance`: the same clock, sockets and store around
the same sim, in TypeScript, which is what the tests, the integration suite and `apps/playground`
drive. Where the two disagree about the clock, a game behaves differently under load in a way no
playtest reproduces — so `clock.rs` and `packages/glue/src/server/driver.ts` are one policy written
twice, and both suites answer the same cases.

## The ticket

`@grove/api`'s allocator mints it, this process verifies it, and nothing between the two is trusted.
It rides the WebSocket **subprotocol** as `grove.ticket.<token>` rather than the query string: a
browser cannot set a header on `new WebSocket(url)` but it can name a subprotocol, and a URL ends up
in access logs, proxy traces and `Referer` while a subprotocol does not.

`playerId` comes off the verified claims and never off a frame. It becomes `player.id`, so it is
what every other peer sees and what persisted `@serverState` is keyed by across a rejoin.

## Running it

```bash
cargo run --release
```

| Variable                 | What                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `GROVE_GAME_ID`          | which game this process serves; a ticket naming another is refused |
| `GROVE_BIND`             | address to bind, `0.0.0.0:0` by default — the port is reported     |
| `GROVE_BUNDLE`           | the compiled sim bundle this world runs                            |
| `GROVE_SIM_CONFIG`       | the `SimConfig` it boots with, as JSON                             |
| `GAME_TOKEN_SECRET`      | shared with `@grove/api`, which mints the tickets                  |
| `GROVE_MANAGER_URL`      | where `@grove/game-manager` is                                     |
| `GROVE_MANAGER_TOKEN`    | this session's bearer for it                                       |
| `GROVE_HEAP_LIMIT_BYTES` | bytes the isolate may reach before the session is torn down        |
| `GROVE_TICK_BUDGET_MS`   | wall-clock one tick may spend inside the isolate                   |

`pnpm run build | test | typecheck` at the repo root reach this crate through `package.json`, whose
scripts shell to cargo. With no Rust toolchain on `PATH` they print one `skipped:` line and succeed,
so working on the TypeScript half does not require installing Rust.

## What the bundle must publish

`GROVE_BUNDLE` is evaluated once and must leave `globalThis.__grove` holding three functions, which is
what `@platform/sim`'s `installIsolateEntry` puts there:

| Call           | Answers                                                       |
| -------------- | ------------------------------------------------------------- |
| `boot(config)` | nothing; builds the world from `GROVE_SIM_CONFIG`             |
| `tick(batch)`  | one `OutputBatch`, as JSON                                    |
| `close()`      | the last `OutputBatch`, whose `saves` this process must drain |

JSON in and JSON out because a string is the only shape that crosses an isolate boundary without
either side holding a reference into the other's heap.

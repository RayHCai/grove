# @grove/game-instance

One game session, in one process: the sockets, the ticket check, the tick clock, the isolate the
world runs in, and the drain. Written in Rust.

The process boundary is the outer isolation and the V8 isolate is the inner one. This process holds
no database credential and no platform secret: the public keys it verifies join tickets with, which
can mint none, and a session-scoped bearer for `@grove/game-manager`, which is the only store it can
reach.

## The two halves, and why they never share a thread

`tokio` owns the listener, one task per peer, and the store. One dedicated thread owns the V8
isolate. They meet at a single bounded channel of `HostEvent`, and that is what gives a tick one order over
everything that happened to it: a `deno_core` `JsRuntime` is not `Send`, and a tick that could be
moved mid-step would not be a fixed step at all.

| File          | Holds                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `main.rs`     | the composition root: config, listener, the drain signals, the session thread               |
| `config.rs`   | the environment `@grove/instance-manager` spawns this process with                          |
| `ticket.rs`   | Ed25519 join-ticket verification, byte for byte with `libs/api-contract`, and spent tickets |
| `net.rs`      | the listener and its caps, one task per peer, and the frame, inbound and idle bounds        |
| `session.rs`  | the tick loop, the write-out, and the watchdog that kills a runaway span                    |
| `isolate.rs`  | the V8 isolate, the prelude that strips its globals, the heap limit and the kill path       |
| `clock.rs`    | the accumulator, the step cap and shed, and the send cadence                                |
| `protocol.rs` | the batch types, mirroring `packages/sim/src/batch.ts`, two of them encoded                 |
| `store.rs`    | `@serverState` over `@grove/game-manager`, which is the only thing it can reach             |
| `saves.rs`    | one writer per host key, so the newest fields a key was handed are the last written         |

`Send` and `OutputBatch` mirror the ENCODED variants in `packages/sim/src/isolate-entry.ts`
(`EncodedSend`, `EncodedBatch`), whose envelopes are already the codec's bytes; every other type in
`protocol.rs` mirrors `batch.ts` field for field.

## What it grants the isolate

Nothing it can call back into. A prelude runs ahead of the bundle and takes away every global that
reaches one of deno_core's ops: it deletes `Deno` and the bootstrap beside it, swaps deno_core's
`console`, which prints through one, for one that writes nothing, and its `queueMicrotask`, which
terminates the isolate through another, for one over a promise, and deletes `WebAssembly` and
`SharedArrayBuffer`, which nothing in the sim reaches. It answers the one function a batch crosses
through, held by this side alone, and that function pins the bundle's entry at boot. A dynamic
import is refused outright. There is no
clock op, because core's only wall-clock probe falls back to `Date.now` and its handler budget is
50 ms, where a millisecond of resolution is a rounding error. There is no ambient Node or DOM global
either: nothing in the engine reaches one, which is what lets the isolate stay this bare.

A tick is a bounded function, not an event loop: the microtask queue is drained explicitly after each
call, which is what lets `startGame` (deliberately not awaited) and every awaiting handler make
progress inside the tick budget, 250 ms by default. The batch is read before the drain, so nothing
a microtask does can change the batch its tick returned.

`@serverState` is checkpointed through `store.rs` and the batch, one writer per key: the newest
fields a key was handed are the last it is written with, a lost compare-and-set is retried with the
newest fields after a fresh read, and the sim is told a key is saved only once its newest write
lands. The creator's `storage` object is a different seam (a promise a handler awaits) and this
crate does not grant one, so a world it runs falls back to core's in-memory store and loses those
writes at session end.

## When a tick dies

A terminated or throwing tick is terminal. `Sim.tick` mutates the world in place with no transaction,
so half a step is a world no later delta repairs: every peer is closed with the reason token
(`heap-limit`, `tick-budget`, `sim-threw`), the killed tick's saves are discarded, and the process
ends. Saves from earlier completed ticks are already durable.

The near-heap-limit callback grants V8 headroom rather than refusing it, which reads backwards and is
not: `terminate_execution` is not instantaneous and V8 keeps allocating while it unwinds, so a
callback that returned the limit unchanged would reach `FatalProcessOutOfMemory` and abort the whole
process. The isolate is discarded either way, so the headroom is never actually spent.

Array buffers count against the same limit, measured after every run because V8 keeps their bytes
outside the heap it bounds, and measured again after a full collection before that ends a world.
What one run allocates before that check is the process's to bound, not the isolate's.

## What it does not own

The world. Everything from a decoded inbound frame to an outbound envelope is `@platform/sim`'s:
the narrowing, admission, the input buffer, the join, the snapshot, the drain of the replication
channels. This half never learns what an entity is, which is what keeps the sim portable enough to
host anywhere.

Its in-process twin is `@platform/glue`'s `GameInstance`: the same clock, sockets and store around
the same sim, in TypeScript, which is what the tests, the integration suite and `apps/playground`
drive. Where the two disagree about the clock, a game behaves differently under load in a way no
playtest reproduces, so `clock.rs` and `packages/glue/src/server/driver.ts` are one policy written
twice, and both suites answer the same cases.

## The ticket

`@grove/api`'s allocator mints it, this process verifies it, and nothing between the two is trusted.
It is signed with Ed25519, and `GROVE_TICKET_PUBLIC_KEYS` lists every public key it may verify
under, so a rotation adds the next key here before the allocator signs with it. A ticket opens one
socket: an admitted one is remembered by its signature until it expires, and one whose expiry is
more than five minutes out is refused, which is what keeps that memory bounded.

It rides the WebSocket **subprotocol** as `grove.ticket.<token>` rather than the query string: a
browser cannot set a header on `new WebSocket(url)` but it can name a subprotocol, and a URL ends up
in access logs, proxy traces and `Referer` while a subprotocol does not.

`playerId` comes off the verified claims and never off a frame. It becomes `player.id`, so it is
what every other peer sees and what persisted `@serverState` is keyed by across a rejoin.

The listener drives hyper itself, because `axum::serve` gives it no timer: a request head has five
seconds to arrive, 64 connections may be short of an upgrade at once and 1024 open in all, and the
bind is loopback, since the agent's player proxy is the one door into a world.

## Running it

```bash
pnpm --filter @grove/game-instance run build:bundle   # rolls the sim into dist/sim.js
cargo run --release
```

`bundle/entry.ts` is the file a real game replaces: it imports its own project manifest and script
registry and hands `createSim` both. What cannot change is its last line: `installIsolateEntry` is
what puts the three functions on the global this process reaches the bundle through. It is bundled
`platform: neutral`, so esbuild refuses a Node built-in here rather than shimming one in.

| Variable                   | What                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `GROVE_GAME_ID`            | which game this process serves; a ticket naming another is refused                    |
| `GROVE_SESSION_ID`         | which session this process is; a ticket minted for another is refused                 |
| `GROVE_BIND`               | address to bind, `127.0.0.1:0` by default; the port is reported                       |
| `GROVE_BUNDLE`             | the compiled sim bundle this world runs                                               |
| `GROVE_SIM_CONFIG`         | the `SimConfig` it boots with, as JSON                                                |
| `GROVE_TICKET_PUBLIC_KEYS` | the Ed25519 public keys a ticket may verify under, comma-separated unpadded base64url |
| `GROVE_MANAGER_URL`        | where `@grove/game-manager` is                                                        |
| `GROVE_MANAGER_TOKEN`      | this session's bearer for it                                                          |
| `GROVE_HEAP_LIMIT_BYTES`   | bytes the isolate may reach before the session is torn down, 256 MiB by default       |
| `GROVE_TICK_BUDGET_MS`     | wall-clock one tick may spend inside the isolate, 250 ms by default                   |

`pnpm run build | test | typecheck` at the repo root reach this crate through `package.json`, whose
scripts shell to cargo: `build` bundles the sim first, `typecheck` is `clippy -D warnings`. With no
Rust toolchain on `PATH` they print one `skipped:` line and succeed, so working on the TypeScript
half does not require installing Rust.

This crate, `@grove/asset-upload-service` and the `request-id` crate they share are one cargo
workspace rooted at `apps/grove`, which is where the lock, the pinned toolchain and the release
profile live; `cargo` finds all three by walking up from here. On Windows the crate links against the **static** CRT, because V8 ships
prebuilt that way and a process with two CRTs has two allocators in it.

## What the bundle must publish

`GROVE_BUNDLE` is evaluated once and must leave `globalThis.__grove` holding three functions, which is
what `@platform/sim`'s `installIsolateEntry` puts there and what this process takes hold of at boot:

| Call           | Answers                                                        |
| -------------- | -------------------------------------------------------------- |
| `boot(config)` | nothing; builds the world from `GROVE_SIM_CONFIG`              |
| `tick(batch)`  | one `EncodedBatch`, as JSON                                    |
| `close()`      | the last `EncodedBatch`, whose `saves` this process must drain |

Every `envelope` in it is already a string the sim's own codec produced, and this process writes it
verbatim. That matters twice: the codec refuses `NaN`, `Infinity` and `undefined` where JSON turns
them into `null` or drops them, and it is the codec the sim measured a `Welcome` against when it
decided whether to chunk one. A host that re-encoded would break both.

JSON in and JSON out because a string is the only shape that crosses an isolate boundary without
either side holding a reference into the other's heap.

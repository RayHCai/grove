# @platform/glue

The composition of one game: an authored project in, a running world and the sessions that reach it
out.

Every step it takes belongs to another package. What belongs here is that they happen in the one
sequence that is correct — including the choices that fail **silently** when made wrongly.

Its server half is also the **in-process host** for `@platform/sim`: the clock, the sockets and the
store the sim deliberately holds none of. `@grove/host` does the same job in Rust for a deployed
session; this is the one the tests, the integration suite and `apps/playground` drive, and it is what
lets a whole game run over `loopbackPair()` with no socket, no port and no GPU.

## Scope

It owns the standing-up of a game and nothing else. It owns no simulation, no wire format, no
rendering, no art, and no game rules; it declares no envelope and adds no field to one. If something
here starts deciding what a game _does_ rather than how it is _started_, it is in the wrong package.

## Two halves, and the one type they share

```ts
import { GameInstance, fileKVStore, listenOn } from '@platform/glue/server';
import { ClientInstance, connectTo } from '@platform/glue/client';
import type { BundleRef } from '@platform/glue';
```

| Export                     | Path      | Is                                                            |
| -------------------------- | --------- | ------------------------------------------------------------- |
| `GameInstance`             | `/server` | One booted world, and the two verbs a host drives it with     |
| `Driver`                   | `/server` | Real time into ticks: the accumulator, the cap and the shed   |
| `listenOn(instance, opts)` | `/server` | Bind in front of a world the caller already holds             |
| `fileKVStore(path)`        | `/server` | `@serverState` that outlives the process, in one JSON file    |
| `ClientInstance`           | `/client` | One composed session, and the two verbs a host drives it with |
| `connectTo(opts)`          | `/client` | Dial, compose over the socket, and join                       |
| `BundleRef`                | `.`       | The code every peer must run, and where a joiner fetches it   |

The two halves never meet. One reaches `ws` and `node:fs`, the other reaches a renderer and a
socket, so each is behind its own subpath for the reason `@platform/client/browser` and
`@platform/engine/host` are: a browser takes the session model without taking a Node runtime's
dependencies with it. The bare `.` path carries the one type both halves name and no values at all —
the server declares a bundle, the client verifies what it fetched against it.

## The socket layer is beside each instance, never inside it

Both instances are transport-agnostic: `GameInstance.accept(transport, playerId)` and
`new ClientInstance({ transport })` each take a pipe someone else made. The socket is a separate
function on top — `listenOn` for the authority, `connectTo` for a session — and both of those
**start** what they are put in front of, because a caller that reached for the socket layer wants the
thing running.

That split is what keeps a whole game drivable over `loopbackPair()` with no socket, no port and no
GPU, which is how this package's own suite runs both ends on one hand-turned clock.

A host builds an instance and its socket separately — `new GameInstance(...)`, then `listenOn(...)` —
because the seam between them is where it grants the instance a capability the project file cannot
describe.

## What construction does, and in what order

`new GameInstance({ project })` runs the whole boot before it returns: validate the file, resolve
every attachment's class through the registry, build the templates, instantiate the placed world,
and run each Game `@onStart` to its first await. Only then will `accept` admit anything.

That order is the reason this package exists. A connection admitted earlier is answered with a
snapshot of a world still being assembled, and a joiner's baseline is the one thing no later delta
repairs.

Two further choices are encoded rather than left to a caller:

- **`pump`, never the `Driver`'s own `start()`.** The driver only turns time into ticks; the batch
  loop that answers the sim's loads and saves lives on the instance, so a world driven through the
  driver alone would ask for a persisted record and never be handed one. `GameInstance.start()` runs
  an interval that pumps.
- **The transport is built synchronously, before any await.** A WebSocket resumes its stream on the
  next tick, so a frame arriving before the transport's own listener exists is simply gone.
  Retention covers a late handler, not a late transport.

## What a session's construction does, and in what order

`new ClientInstance({ ... })` composes and registers, but joins nothing — `start()` is what sends
the request. Three orderings are encoded here rather than left to a caller, each of which fails
quietly:

- **The state listener is an option, not a later registration.** `start()` can reach `failed`
  synchronously, and a listener attached after it would never hear the only transition there was. So
  `onState` is taken at construction and wired before anything is sent.
- **A dial is abandoned through an `AbortSignal`.** A dial resolves on its own schedule, so a host
  that gave up while one was in flight holds no session to close and its socket becomes a player that
  never leaves. `connectTo` closes the transport and constructs nothing when the signal is already
  aborted.
- **`close()` unsubscribes before it destroys.** `GameClient.destroy` does not clear the lifecycle's
  own subscribers, so a host that only destroyed would keep being told about a session it dropped,
  and its handler would run against state it has already torn down.

A host disposing anything of its own that touches the renderer does it **before** `close()`: the
session's teardown reaches the same renderer, and only the host knows which nodes are its.

## What the host owes the sim

The sim reads no clock, opens no socket and writes to no store. Everything it needs arrives in one
input batch and everything it wants done comes back in one output batch, and this class is the half
that acts on it: it writes the `sends` (one `encode` per envelope, however many peers are in its
`to`), closes the sockets `closes` names, reads the records `loads` asks for and hands them back on
a later tick, and writes `saves` through — telling the sim which of them landed, so a rejoin inside
one session reads its own values back whether or not the store has caught up.

`close()` settles once every write it started has, over `allSettled` rather than `all`: a store that
rejects must release the drain rather than hold a shutdown open on the one write that will never
land.

## Identity is the host's

`accept(transport, playerId)` takes the id from whatever the host resolved, never from a frame —
which is why `ListenOptions.identify` reads the upgrade request. Whatever it returns is what the game
trusts, and it reaches every other peer as `player.id`, so it must be a per-game id rather than an
account key. Returning `undefined` admits the connection anonymously and persists nothing.

## One instance per process

`GameInstance` is scoped to one world, and the current runtime is not safe to multiply. Core keeps a
single module-global runtime — `loadGame` calls `createRuntime()` — so a second instance in one
process repoints it. Core's own entry points wrap `withRuntime` and so survive that, but creator
module state does not: a `let` at module scope in a script is per-process, not per-instance.

Scale by processes. `GameInstance` is deliberately shaped so that hosting several later is a change
inside this package rather than to its callers.

## What it does not do

It does not build a script bundle. Lowering, the determinism check, linking and hashing are
`@platform/scripting/toolchain`'s, they need a filesystem full of source and a bundler, and they run
once when a creator publishes — not every time a world is spawned. This package takes an
already-linked chunk's `BundleRef` and passes it to the handshake.

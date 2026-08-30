# @platform/glue

The composition of one game instance: an authored project in, a running world out.

Every step it takes belongs to another package. What belongs here is that they happen in the one
sequence that is correct — including the choices that fail **silently** when made wrongly.

## Scope

It owns the standing-up of a game and nothing else. It owns no simulation, no wire format, no
rendering, no art, and no game rules; it declares no envelope and adds no field to one. If something
here starts deciding what a game _does_ rather than how it is _started_, it is in the wrong package.

## The two entry points

```ts
import { GameInstance } from '@platform/glue';
import { fileKVStore, listenOn } from '@platform/glue/node';
```

| Export                     | Is                                                         |
| -------------------------- | ---------------------------------------------------------- |
| `GameInstance`             | One booted world, and the two verbs a host drives it with  |
| `listenOn(instance, opts)` | Bind in front of a world the caller already holds          |
| `fileKVStore(path)`        | `@serverState` that outlives the process, in one JSON file |

A host builds the two halves itself — `new GameInstance(...)`, then `listenOn(...)` — because the
seam between them is where it grants the instance a capability the project file cannot describe.

`@platform/glue` opens no socket and reads no file. The Node host is behind `./node`, for the reason
`@platform/client/browser` and `@platform/engine/host` are subpaths: a consumer takes the instance
model without taking `ws` and `node:fs` with it.

## What construction does, and in what order

`new GameInstance({ project })` runs the whole boot before it returns: validate the file, resolve
every attachment's class through the registry, build the templates, instantiate the placed world,
and run each Game `@onStart` to its first await. Only then will `accept` admit anything.

That order is the reason this package exists. A connection admitted earlier is answered with a
snapshot of a world still being assembled, and a joiner's baseline is the one thing no later delta
repairs.

Two further choices are encoded rather than left to a caller:

- **`pump`, never `GameServer.start()`.** `start` drives the Driver directly and skips the
  join-deadline sweep, so a connection that opens and never joins holds one of the unjoined slots
  for good. `GameInstance.start()` runs an interval that pumps.
- **The transport is built synchronously, before any await.** A WebSocket resumes its stream on the
  next tick, so a frame arriving before the transport's own listener exists is simply gone.
  Retention covers a late handler, not a late transport.

## Identity is the host's

`accept(transport, playerId)` takes the id from whatever the host resolved, never from a frame —
which is why `ListenOptions.identify` reads the upgrade request. Whatever it returns is what the game
trusts, and it reaches every other peer as `player.id`, so it must be a per-game id rather than an
account key. Returning `undefined` admits the connection anonymously and persists nothing.

## One instance per process

`GameInstance` is scoped to one world, and the current runtime is not safe to multiply. Core keeps a
single module-global runtime — `loadGame` calls `createRuntime()` — so a second instance in one
process repoints it, and the entry points that do not wrap `withRuntime` would write into the wrong
world. Creator module state has the same shape: a `let` at module scope in a script is per-process,
not per-instance.

Scale by processes. `GameInstance` is deliberately shaped so that hosting several later is a change
inside this package rather than to its callers.

## What it does not do

It does not build a script bundle. Lowering, the determinism check, linking and hashing are
`@platform/scripting/toolchain`'s, they need a filesystem full of source and a bundler, and they run
once when a creator publishes — not every time a world is spawned. This package takes an
already-linked chunk's `BundleRef` and passes it to the handshake.

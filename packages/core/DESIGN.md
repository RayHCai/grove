# `@platform/core` — internals

**TL;DR** — the runtime every line of creator code runs against: entities, the world, the script model and
its decorators, handler dispatch, the fixed-step loop, timers/tweens, `@serverState` and the replication
marks. No canvas, no sockets, no DOM, no clock of its own — core is **pumped** (`Loop.step`), and everything
outside its walls is a seam with a null implementation, so the whole package runs in Node. `@platform/engine`
re-exports it as the creator API; `@platform/server` and `@platform/client` drive it from either side of the
wire and read its marks to replicate. Only dependency: `@platform/math`.

## Layout

| Path           | Owns                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | barrel, grouped by concern; `PACKAGE_NAME`                                                                                                                                                                                                                                                                                                                                                                |
| `config.ts`    | `DEFAULT_SIM_RATE`/`DEFAULT_SEND_RATE` (60/20), `BREAKER_THRESHOLD` 100, `MAX_SEND_DEPTH` 64, `MAX_DEDUP_KEYS` 1024, `MAX_LOG_RECORDS` 512, `MAX_REWIND_MS` 250, `MAX_BUBBLE_LENGTH` 200, `resolveConfig`                                                                                                                                                                                                 |
| `ids.ts`       | `EntityId` brand, `NO_ENTITY`, and thin wrappers over `@platform/math`'s generation-packed handles, where the **arithmetic, never bitwise** rule lives (`<<` wraps int32 at generation 128 and mints live handles)                                                                                                                                                                                        |
| `errors.ts`    | `LoadError`, `HandlerErrorRecord`                                                                                                                                                                                                                                                                                                                                                                         |
| `script/`      | `types.ts` locations/phases/concurrency · `metadata.ts` per-class registry · `bases.ts` the four bases · `decorators.ts` all 16 handler decorators + `@serverState` and the `Symbol.metadata` polyfill                                                                                                                                                                                                    |
| `dispatch/`    | `scope-tree.ts` runtime→host→invocation · `ambient.ts` current-invocation plumbing · `acting-player.ts` the acting-player ambient · `instances.ts` attached-script registry · `breaker.ts` throw counters · `dispatcher.ts`                                                                                                                                                                               |
| `loop/`        | `store-registry.ts` snapshot contract · `timers.ts` sleep/every/after heap · `tweens.ts` the one tween engine · `loop.ts` `step`/`snapshot`/`restore`                                                                                                                                                                                                                                                     |
| `world/`       | `entity-table.ts` the per-entity record and hierarchy over math's `SlotTable` · `transform-store.ts` SoA + dirty bitset · `tag-index.ts` · `entity-manager.ts` spawn/destroy/facade cache · `broadphase.ts`                                                                                                                                                                                               |
| `state/`       | `host-record.ts` values + type tags · `channels.ts` structural journal + state marks · `backing.ts` the `@serverState` accessor pair · `immutable.ts` deep-readonly predicate                                                                                                                                                                                                                             |
| `runtime/`     | the creator-facing facades (`Entity`, `Game`, `Player`, `Camera`, `HUD`, `random`, `assets`, `sound`/`music`, `sleep`/`every`/`after`, `request`, motion verbs, wrappers, movement) plus the plumbing: `runtime.ts`, `wiring.ts`, `load-game.ts`, `hosts.ts`, `roster.ts`, `contacts.ts`, `regions.ts`, `lag-ring.ts`, `action-states.ts`, `seams.ts`, `physics.ts`, `prng-store.ts`, `transform-view.ts` |

## 1. Script model

- **Location is the base class, host is a type parameter.** `ServerScript` / `ClientScript` / `SyncedScript`
  carry a static `__location`; `BaseScript` is abstract and names none. The host kind comes from the attach
  site (`entity.addScript`, `player.addScript`, …), never from a decorator argument.
- **Registry:** two tables per class on the decorator metadata object — `handlers: HandlerDecl[]`
  (`{event, kind, methodName, opts}`, 14 kinds) and `state: Set<field>`. Metadata objects inherit
  prototypally and `getOrCreateMetadata` forks the inherited record on a class's first own write, so a
  subclass inherits its parent's declarations, an override re-registers nothing, and a sibling's push never
  reaches the base. Insertion order is dispatch order.
- **Standard (TC39) decorators only**, contained to `decorators.ts`, which installs
  `Symbol.metadata ??= Symbol('Symbol.metadata')` — absent on node 24, and without it every table is empty.
  `lib` carries `ESNext.Decorators` and nothing anywhere sets `experimentalDecorators`. The metadata key and
  the three `@serverState` symbols are `Symbol.for`, since the `src` and `dist` copies of core can be loaded in
  one process and a plain `Symbol()` would differ between them.
- **Wire-time rejections** live in `Wiring.#reject` + the hoist walk, all `LoadError`: `SyncedScript` on a
  camera/screen host, `ServerScript` on a screen host, `@onRequest` off a `ServerScript`,
  `@onPlayerJoin`/`@onPlayerLeave` off a Game-hosted `ServerScript`, two `@serverState` fields claiming one
  name on a host.

## 2. Dispatch

- **Synchronous to the first await.** `dispatch` loops matching handlers, calls each up to its first `await`,
  and returns a promise settling when all finish — so `crate.send('break'); crate.alive === false` holds for a
  synchronous handler.
- **Matching includes the input phase.** `DispatchOptions.phase` is compared against `decl.opts.on ?? 'press'`
  for `onEvent`; a dispatch naming **no** phase matches every declaration, which is what `Entity.send` needs.
- **Concurrency is per script instance** (`${instanceId}#${method}`), defaulting to `ignore` except
  `onCollide`/`onEnter`/`onExit` which default to `concurrent`. `restart` cancels the running invocation; there
  is no `queue`.
- **Scopes:** runtime → host → invocation. Destroying a host cancels its invocations, timers and tweens;
  `restore` sweeps invocations whose `startTick` is newer than the snapshot. Engine awaitables restore the
  ambient invocation on resume (`resumeWith`) — awaiting a promise core did not hand out falls back to the host
  scope. `ctx.player` is saved and restored as a second ambient over the same body, so a wrapper's
  omitted-player default holds for the synchronous part of a handler and not across an await.
- **Error boundary:** a throw at the invocation boundary is caught, logged (`scriptClass`, `method`, `hostId`,
  `tick`, `event`, `stack`), deduped by `class#method#message` — one record per distinct triple, the repeats
  counted and readable through `dispatcher.throwCount` — and 100 **consecutive** throws disable that
  `(instance, method)`; a success resets it, and an async handler counts as a success only once its promise
  settles. Breaker counts are snapshot state; the dedup map is not, and both it and the default log are capped
  so a session cannot grow them without bound.
  Wiring throws are fatal (`LoadError`) because a half-hoisted host record matches no declaration.

## 3. Loop, tick order, snapshot

`step(tick, opts)` is the only entry point — one tick at an explicit index, no clock, `dt` always
`1/simRate`. The accumulator that decides how many ticks a frame owes belongs to the host, which is the only
layer that knows what its clock means; `step` establishes the ambient runtime for the tick. Tick order
(`loop.ts`, passes built in `load-game.ts`):

```
1  adopt tick        rt.tick = the argument, NOT an increment
2-3 input            passes.input  — stub in core; installed by the endpoint
4  movement          per player with a movement instance, live avatars only
5  contacts          ContactSource.pairs() → @onCollide per tag, both directions
6  regions           passes.regions — stub
7  timers & tweens   TimerHeap.advance(), TweenEngine.advance(), passes.countdowns — stub
8  @onUpdate         server + synced locations only
9  destroy drain     EntityManager.drainDestroyed()
10 replicate         server only: LagRing.capture(tick)
```

- `opts.replay` makes the dispatcher skip client-located handlers; `EffectSink` is the drop point for
  one-shot effects. `opts.scope` reaches the passes, and `snapshot(scope)` is the only thing that acts on it.
- **Snapshot completeness is a registry, not a list.** A `SnapshotStore` declares `storeName`, a `scopeMode`
  (`filtered` | `whole` | `derived`, no default) and `createBuffer`/`capture(into, scope)`/`apply`. Six stores
  register, in capture order: `entities`, `transforms`, `tags`, `prng` (whole — one interleaved stream, no
  per-entity subsequence), `breaker` (whole — keyed by instance id, which no set of entity ids narrows),
  `timers`. `TweenEngine` and the host records are **not** stores, so a rewind restores transforms but neither
  an in-flight tween nor a `@serverState` value.
- **A `filtered` buffer records its own coverage**, and `apply` writes only that: the slots for `transforms` and
  `tags`, the owning host scopes for `timers`. Restoring the whole range instead would overwrite every
  out-of-scope entity with the slots the capture never filled, which is the client's remote entities.
- `restore(s)` applies the buffers, resets `rt.tick`, then sweeps parked invocations newer than `s.tick`,
  releasing their concurrency locks. Bit-exactness is claimed for synchronous handlers only — a parked
  continuation is a heap closure no buffer holds.
- **The lag ring** (`lag-ring.ts`) holds `ceil(simRate * 250ms / 1000)` reused transform buffers, each with
  the live id list of its tick; a historical query builds a throwaway `Broadphase` over one and marks nothing.
  The ids are real `EntityId`s, generation included, because every caller feeds the results straight back into
  stores that would otherwise resolve a slot index to the wrong entity.

## 4. State

- **`@serverState` is never a data property.** The field decorator records the name and, via `addInitializer`
  (which runs _after_ the field is defined), moves the authored value into a local backing map, `delete`s the
  own property and installs an accessor pair that reads a redirectable target symbol at call time. Wiring
  points that target at the host record's `values` map, installs the mark closure, and defines the same
  accessor on the host object — so `this.credits` and `player.credits` are one value and one mark per write.
- **Seeding:** `rt.persisted?.get(hostId, field)` wins over the authored value only when its type tag matches
  (primitive kind, or a one-level shape hash for objects/arrays); otherwise the initializer wins.
- **Host records** live in `HostTable` keyed `game` | `player:<id>` | `entity:<id>` | `camera:<playerId>` |
  `screen:<name>`, each carrying its scope id, values, tags, bound wrappers and `markDirty`.
- **Two replication channels here, one on the store.** `ReplicationChannels` owns the ordered structural
  journal (`spawn` | `destroy` | `reparent` | `tag` | `attach`) and the `(record, field)` state set;
  the **transform** channel is `SimTransformStore`'s own dirty index, which is what lets the server's sink and
  the client's `SceneSink` drain it independently. None of the three is captured by snapshot — they are output
  bookkeeping. `detach()` journals `reparent → NO_ENTITY`; `attachTo` unlinks silently and journals one op.
- **Wrappers:** `StatefulWrapper` gives `bind(record, field)` (throws if bound twice), `mark()`, and
  `serialize`/`restore`; `Scoreboard`, `Leaderboard`, `Inventory`, `Team` sit on it and mark per key with no
  decorator. An omitted player defaults to the dispatcher's acting-player ambient in `Scoreboard`, and throws
  in `Leaderboard.submit`, which has no one to attribute a bare score to. `Countdown` (own `onZero`, not
  `@onEnd`) and `Storage` (over the `KVStore` seam) sit outside it.
- `Immutable<T>` is the deep-readonly predicate that collapses a mutable declaration to a branded marker.

## 5. World

- `EntityTable` holds the per-entity `template`/`ownerId`/`parent`/`children`/`alive`/`destroyPending` in a
  `SlotTable` from `@platform/math`, which owns the slots, the freelist and the generations;
  `SimTransformStore` holds the numbers in `Float64Array`s at the **same
  slot index**. `liveIds()` is ascending slot = creation order. A stale handle never throws — `indexOf` returns
  `-1` and record-based reads report dead — but the SoA stores address by slot without revalidating, so a write
  through a stale facade lands on whatever now owns that slot.
- `Entity` is a cached facade over an id (`===` identity holds per live id); the transform is readonly and
  reads return copies. Timed verbs (`glideTo`, `fadeTo`, `growTo`, `spin*`) are all `TweenEngine.start` with
  last-one-wins per `(target, prop)`. Hierarchy carries position only.
- `destroy()` is logical-now, teardown-at-end-of-tick: `alive` flips false and cascades to children
  immediately; the drain unparents, clears tags, releases the slot, cancels timers/tweens, removes instances
  and the host, journals `destroy`, and bumps the generation.
- `Broadphase` is naive O(n²) over a `TransformView`, ascending id order, and takes its transform source as a
  constructor argument — the live store or a ring buffer. `liveTransformView` is the one factory for a view
  over the live stores, so `rt.broadphase`'s point-only view and `ContactSource`'s differ in one argument:
  the half-extent lookup. `ContactSource` layers self/parent/child exclusion and tag filtering on top;
  half-extents come from `collider.bounds`.
- `RegionIndex` is build-time named rectangles with point queries; `find({ in })` resolves against it.

## 6. Runtime, facades, load order

`Runtime` (`runtime.ts`) is the one mutable slot holding every store, the scope tree, host table, channels,
dispatcher, seams, `tick`, `isServer` and the collaborators `loadGame` fills in. `createRuntime()` /
`withRuntime(rt, fn)` / `clearRuntime()` make the spec's module consts (`game`, `random`, `assets`)
facades over a swappable world rather than process singletons — `game` is a `Proxy` returning methods
**unbound**, so neither the const nor a method read off it captures a stale instance. Anything a facade needs
lives on the runtime and is resolved per call (`assets`, the player lookup behind `Scoreboard.top`), never in a
module slot a second `loadGame` would repoint. Script instances get their runtime stamped at attach time, so
simulation code inside a tick never has to consult the ambient slot at all.

`loadGame(manifest)` → build world (bounds, regions, assets, collaborators, `passes`) → attach Game scripts
(wire + hoist, **no** `@onStart`) → `startGame(rt)` runs Game `@onStart` to its first await →
`joinPlayer` / `leavePlayer` release and end sessions. The manifest takes `role`, `simRate`, `bounds`,
`regions`, `assets`, `gameScripts`. `leavePlayer` dispatches `@onPlayerLeave` **before** the roster removal so
the handler can still read the player; `PlayerManager.adopt` keeps a wire-supplied `index` where `create`
mints one.

`action-states.ts` is deliberately pure — no runtime, no dispatch — because both endpoints fold input edges
and a second implementation of the one-tick-wide `pressed`/`released` rule would diverge.

## 7. Seams

Each is an interface with a null implementation, so every live member is exercisable in Node.

| Seam            | In core                                                              | Real owner            |
| --------------- | -------------------------------------------------------------------- | --------------------- |
| `Clock`         | `ManualClock` (held on the runtime; the host's accumulator reads it) | host app              |
| `PhysicsSink`   | `NullPhysicsSink` — integrates position, `blocked` all false         | Rapier                |
| `KVStore`       | `MemoryKVStore`                                                      | `@platform/platform`  |
| `EffectSink`    | `NullEffectSink` — audio, particles, camera shake                    | client / audio layer  |
| `Broadphase`    | naive O(n²) over any `TransformView`                                 | Rapier or a grid      |
| `ContactSource` | over `Broadphase`                                                    | Rapier                |
| `RegionIndex`   | built once at load                                                   | core (panel-authored) |

`InputSource`, `SceneSink` and `ReplicationSink` are **not** declared here: the endpoints drive `passes.input`
and read `consumeDirty()` / `drainStructural()` / `drainState()` directly.

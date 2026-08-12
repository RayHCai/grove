# `@platform/core` — internals

**TL;DR** — the runtime every line of creator code runs against: entities, the world, the script model and
its decorators, handler dispatch, the fixed-step loop, timers/tweens, `@serverState` and the replication
marks. No canvas, no sockets, no DOM, no clock of its own — core is **pumped** (`Loop.step`), and everything
outside its walls is a seam with a null implementation, so the whole package runs in Node. `@platform/engine`
re-exports it as the creator API; `@platform/server` and `@platform/client` drive it from either side of the
wire and read its marks to replicate. Only dependency: `@platform/math`.

## Layout

| Path                  | Owns                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`        | barrel, grouped by concern; `PACKAGE_NAME`                                                                                                                                                                                                                                                                                                                                           |
| `config.ts`           | `SIM_RATES`/`SEND_RATES` + defaults (60/20), `BREAKER_THRESHOLD` 100, `MAX_SEND_DEPTH` 64, `MAX_REWIND_MS` 250, `MAX_BUBBLE_LENGTH`, `resolveConfig`                                                                                                                                                                                                                                 |
| `ids.ts`              | `EntityId` brand, `NO_ENTITY`, generation-packed pack/unpack — **arithmetic, never bitwise** (`<<` wraps int32 at generation 128 and mints live handles)                                                                                                                                                                                                                             |
| `errors.ts`           | `LoadError`, `DeterminismError`, `HandlerErrorRecord`, `Diagnostics` message texts                                                                                                                                                                                                                                                                                                   |
| `script/`             | `types.ts` locations/phases/concurrency · `metadata.ts` per-class registry · `bases.ts` the four bases · `decorators.ts` all 16 handler decorators + `@serverState` and the `Symbol.metadata` polyfill                                                                                                                                                                               |
| `dispatch/`           | `scope-tree.ts` runtime→host→invocation · `ambient.ts` current-invocation plumbing · `instances.ts` attached-script registry · `breaker.ts` throw counters · `dispatcher.ts`                                                                                                                                                                                                         |
| `loop/`               | `store-registry.ts` snapshot contract · `timers.ts` sleep/every/after heap · `tweens.ts` the one tween engine · `loop.ts` `step`/`snapshot`/`restore`                                                                                                                                                                                                                                |
| `world/`              | `entity-table.ts` slots/freelist/generations/hierarchy · `transform-store.ts` SoA + dirty bitset · `tag-index.ts` · `entity-manager.ts` spawn/destroy/facade cache · `broadphase.ts`                                                                                                                                                                                                 |
| `state/`              | `host-record.ts` values + type tags · `channels.ts` structural journal + state marks · `backing.ts` the `@serverState` accessor pair · `immutable.ts` deep-readonly predicate                                                                                                                                                                                                        |
| `runtime/`            | the creator-facing facades (`Entity`, `Game`, `Player`, `Camera`, `HUD`, `random`, `assets`, `sound`/`music`, `sleep`/`every`/`after`, `request`, motion verbs, wrappers, movement) plus the plumbing: `runtime.ts`, `wiring.ts`, `load-game.ts`, `hosts.ts`, `roster.ts`, `contacts.ts`, `regions.ts`, `lag-ring.ts`, `action-states.ts`, `seams.ts`, `physics.ts`, `prng-store.ts` |
| `testkit/fixtures.ts` | decorated test classes, compiled by the build and imported from `dist`                                                                                                                                                                                                                                                                                                               |

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
  The metadata key and the three `@serverState` symbols are `Symbol.for`, since the `src` and `dist` copies of
  core are loaded at once and a plain `Symbol()` would differ between them.
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
  scope.
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
2-3 input            passes.input  — stub in core; driven by the client/tests
4  movement          per player with a movement instance, live avatars only
5  contacts          ContactSource.pairs() → @onCollide per tag, both directions
6  regions           passes.regions — stub
7  timers & tweens   TimerHeap.advance(), TweenEngine.advance(), passes.countdowns — stub
8  @onUpdate         server + synced locations only
9  destroy drain     EntityManager.drainDestroyed()
10 replicate         server only: LagRing.capture(tick)
```

- `opts.replay` makes the dispatcher skip client-located handlers; `EffectSink` is the drop point for
  one-shot effects.
- **Snapshot completeness is a registry, not a list.** A `SnapshotStore` declares `storeName`, a `scopeMode`
  (`filtered` | `whole` | `derived`, no default) and `createBuffer`/`capture(into, scope)`/`apply`. Six stores
  register, in capture order: `entities`, `transforms`, `tags`, `prng` (whole — one interleaved stream, no
  per-entity subsequence), `breaker` (whole — keyed by instance id, which no set of entity ids narrows),
  `timers`. A test asserts every store names a mode.
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
  decorator. `Countdown` (own `onZero`, not `@onEnd`) and `Storage` (over the `KVStore` seam) sit outside it.
- `Immutable<T>` is the deep-readonly predicate that collapses a mutable declaration to a branded marker.

## 5. World

- `EntityTable` holds slots, a freelist and generations plus per-entity `template`/`ownerId`/`parent`/
  `children`/`alive`/`destroyPending`; `SimTransformStore` holds the numbers in `Float64Array`s at the **same
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
  constructor argument — the live store or a ring buffer. `ContactSource` layers self/parent/child exclusion
  and tag filtering on top; half-extents come from `collider.bounds`.
- `RegionIndex` is build-time named rectangles with point queries; `find({ in })` resolves against it.

## 6. Runtime, facades, load order

`Runtime` (`runtime.ts`) is the one mutable slot holding every store, the scope tree, host table, channels,
dispatcher, seams, `tick`, `isServer` and the collaborators `loadGame` fills in. `createRuntime()` /
`withRuntime(rt, fn)` / `clearRuntime()` make the spec's module consts (`game`, `random`, `assets`, `hud`)
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

## 8. Present-tense gaps

Load-bearing for anyone reading a facade and assuming behaviour:

- **Stub passes:** `input`, `regions`, `countdowns` are empty, so region `@onEnter`/`@onExit`, checkpoints and
  `Countdown.advance()` never fire from the loop — a `Countdown` counts down only if something else calls it,
  though it does take its rate from the runtime it was built on. There is no display-rate `frame(dt)` entry point.
- **`StepOptions.scope`** is threaded into the passes and ignored by them; only `snapshot(scope)` honours it.
- **Not snapshot stores:** `TweenEngine` and the host records. A rewind restores transforms but not in-flight
  tweens or `@serverState` values.
- **Persistence is read-side only.** Wiring seeds from `rt.persisted`; nothing checkpoints, and
  `StatefulWrapper.serialize`/`restore` are exercised only by tests.
- **`asSeen`** resolves `getTouching` and `WorldQuery.find` against the ring's _latest_ capture, not
  `ctx.viewTick`. No clamp against `MAX_REWIND_MS`, no latency validation.
- **`rt.broadphase`'s view reports zero half-extents**, so `find({ near })` is point-distance only;
  `ContactSource` builds its own view with real collider extents.
- **`Diagnostics` and `DeterminismError` are declared and never thrown** — no runtime enforcement of
  `Math.random` / `camera.viewport` / `Storage` reads in synced code. `Immutable<T>` is not applied by the
  `@serverState` decorator either; it is asserted by a type-level test only.
- **`scope.cancel` is never populated**, so cancelling an invocation marks it dead and frees its lock but does
  not abort a continuation already awaiting a non-engine promise.
- **Presentation shells** (“tier C” in the source comments): `hud` is `null!` (any use throws), `HUD`/`HUDScreen` methods are no-ops, `Cursor` is a
  null object, `Camera.glideTo`/`zoomTo` snap and `viewport` is a fixed 800×600 box, `Entity.play`/
  `playEffect`/`stopAnimation`/`clearSay`/`think` are `EffectSink` calls or no-ops, and `collider`/`animation`
  are plain optional fields nothing populates. `say()` currently journals a synthetic `tag` op `say:<text>`.
- **Templates:** `Wiring.attachTemplateScripts` is a no-op and the manifest declares no template scripts, so a
  spawned avatar gets only its movement class.
- **`request()`** in loopback dispatches to _every_ server-located `@onRequest` instance with
  `ctx.player = localPlayer ?? players[0]`, unscoped by host.
- Unused inside core: `resolveConfig`/`EngineConfig`, `withInvocation`, `Scoreboard.setActingPlayer` —
  so the spec's "defaults to the acting player" is aspirational, and `Scoreboard.add(1)` with no player
  argument throws rather than silently dropping the score.

## 9. Build and test

- **Node 24** (`.node-version`); prefix with `mise exec --` if `node -v` disagrees. `pnpm test` runs
  `tsc -b` **then** `vitest run`, and that order is required: the runner's oxc transform passes TC39 standard
  decorators through untransformed, so decorated fixtures live in `src/testkit/` and tests import them from
  `dist/testkit/fixtures.js`. Test files carry no decorator syntax.
- `tsconfig.json` sets `lib: ["ES2023", "ESNext.Decorators"]`; **no** `experimentalDecorators` anywhere.
- **Engine symbols use `Symbol.for`** — the metadata key and the three `@serverState` symbols are read from the
  `src` and `dist` copies at once, and a plain `Symbol()` would differ between them.
- 14 test files, 70 tests: metadata inheritance and copy-on-write, the accessor pair and its no-data-property
  invariant, per-instance concurrency + the breaker + phase matching, destroy/stale-handle/`getTouching`,
  the three channels and detach journalling, snapshot round-trip + determinism run + registry coverage, the
  parked-invocation sweep, the lag ring's read-without-write property and id fidelity, load order/`@onRequest`
  loopback/roster dispatch, wrapper binding and serialize, the type-level immutability fixture, what a scoped
  snapshot must leave alone, and the handler boundary under an async throw and a nested send.

## 10. Corrections

What implementing and reviewing this corrected. A row here means the prose above once asserted the
opposite; reading what a sentence replaced tells you how far to trust the ones beside it.

| Claimed                                                         | Actually                                                                                                                                                                                                                                   | Caught by                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `snapshot(scope)` captures the scope and `restore` puts it back | A scoped `apply` wrote the **whole** `[0, count)` range, so restoring one entity teleported every other entity to the buffer's untouched zeros and cancelled every timer the capture skipped.                                              | `scoped-snapshot` — "leaves out-of-scope ones untouched", "keeps a timer owned by a host outside the scope" |
| A scoped capture is the cheap path                              | It sized the buffer only on the whole-world branch, so past 64 entities a scoped capture silently dropped the writes a `TypedArray` refuses out of range.                                                                                  | `scoped-snapshot` — "even when the buffer starts smaller than the world"                                    |
| Any success resets the breaker                                  | Success was recorded when the call _returned_, which for an async handler is its first `await` — so a handler that always rejects reset its own counter and never tripped.                                                                 | `handler-boundary` — "counts an async throw"                                                                |
| Throws are deduped by `class#method#message`                    | The dedup map was written and never read; every repeat logged another record into an uncapped array. One record per triple now, repeats counted.                                                                                           | `handler-boundary` — "logs one record per distinct message"                                                 |
| Engine awaitables restore the ambient invocation                | Only `resumeWith` did. A synchronous nested `send` cleared the slot to `null` on return, so a timer the outer handler started afterwards was owned by no host and outlived its entity.                                                     | `handler-boundary` — "leaves the outer handler its own invocation"                                          |
| The lag ring answers historical queries                         | Its view handed out bare slot indexes and inferred liveness from a non-zero scale, so callers resolved the wrong entity or a released slot; released slots keep scale 1. Real ids now.                                                     | `lag-ring` — "answers in real EntityIds"                                                                    |
| `breaker` is a `filtered` store                                 | Its keys are instance ids, which no set of entity ids narrows; it captured everything under either mode. Declared `whole`.                                                                                                                 | Reading the store against the registry contract                                                             |
| Module consts are facades over a swappable world                | `assets` and the `Scoreboard.top` player lookup were module slots a second `loadGame` repointed, and the `game` proxy handed out **bound** methods that pinned the runtime they were read from.                                            | Review; both now resolve off the runtime per call                                                           |
| `BaseMovement.tick` is sealed                                   | Nothing enforced it, so an override changed the stage order the two endpoints replay. `attachMovement` rejects it at load.                                                                                                                 | Review; the check counts `tick` declarations in the prototype chain                                         |
| `Loop.advance` is the accumulator over `step`                   | No caller used it — client, server and playground each own theirs — and it clamped nothing, so one long frame replayed the whole backlog. Deleted; `step` is the only entry point.                                                         | Reading callers; every host already had an accumulator                                                      |
| `MemoryKVStore` separates scope and key with a NUL              | Confirmed — it really was a raw NUL byte, which no test would have noticed had it been eaten by a reformat. Now a spelled-out escape, length-prefixed so neither part can forge the other.                                                 | Review; hexdump of the source line                                                                          |
| `Countdown` counts in ticks at the sim rate                     | It hardcoded 60, so on a 30 Hz world it held twice the ticks asked for and reported twice the seconds. It reads the runtime's rate and rescales on a change — but still nothing ticks it.                                                  | Review; the loop's `countdowns` pass is a documented stub                                                   |
| A timer's owner is the ambient invocation's host                | `oscillate(other)` from a Game handler left the timer owned by the _caller_, outliving `other` and writing to its released slot. The animated entity owns it. `-1` as a miss sentinel also collided with a real cancel; `NO_SCOPE` cannot. | Review; `cancelScope(NO_SCOPE)` is now a no-op                                                              |

# `@platform/core` — internals

**TL;DR** — the runtime every line of creator code runs against: entities, the world, the script model and
its decorators, handler dispatch, the fixed-step loop, timers/tweens, `@serverState` and the replication
marks. No canvas, no sockets, no DOM, no clock of its own — core is **pumped** (`Loop.step`), and everything
outside its walls is a seam with a null implementation, so the whole package runs in Node. `@platform/engine`
re-exports it as the creator API; `@platform/server` and `@platform/client` drive it from either side of the
wire and read its marks to replicate. Dependencies: `@platform/math`, and `@platform/project` for the
authoring types alone — its `validate` is the server's to call, so the validator stays out of core's import
path and core only ever receives an already-valid manifest.

## Layout

| Path           | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | barrel, grouped by concern; `PACKAGE_NAME`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `config.ts`    | `DEFAULT_SIM_RATE`/`DEFAULT_SEND_RATE` (60/20), `BREAKER_THRESHOLD` 100, `MAX_SEND_DEPTH` 64, `MAX_DEDUP_KEYS` 1024, `MAX_LOG_RECORDS` 512, `MAX_REWIND_MS` 250, `MAX_BUBBLE_LENGTH` 200, `resolveConfig`                                                                                                                                                                                                                                                                                                                                                                          |
| `ids.ts`       | `EntityId` brand, `NO_ENTITY`, and thin wrappers over `@platform/math`'s generation-packed handles, where the **arithmetic, never bitwise** rule lives (`<<` wraps int32 at generation 128 and mints live handles)                                                                                                                                                                                                                                                                                                                                                                 |
| `errors.ts`    | `LoadError`, `HandlerErrorRecord`, `BreakerTrip`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `script/`      | `types.ts` locations/phases/concurrency · `metadata.ts` per-class registry · `bases.ts` the four bases · `decorators.ts` all 16 handler decorators + `@serverState` and the `Symbol.metadata` polyfill                                                                                                                                                                                                                                                                                                                                                                             |
| `dispatch/`    | `scope-tree.ts` runtime→host→invocation · `ambient.ts` current-invocation plumbing · `acting-player.ts` the acting-player ambient · `instances.ts` attached-script registry · `breaker.ts` throw counters · `dispatcher.ts`                                                                                                                                                                                                                                                                                                                                                        |
| `loop/`        | `store-registry.ts` snapshot contract · `timers.ts` sleep/every/after heap · `tweens.ts` the one tween engine · `loop.ts` `step`/`snapshot`/`restore`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `world/`       | `entity-table.ts` the per-entity record and hierarchy over math's `SlotTable` · `transform-store.ts` SoA + dirty bitset · `tag-index.ts` · `entity-manager.ts` spawn/destroy/facade cache · `templates.ts` the template registry and `instantiate` · `broadphase.ts`                                                                                                                                                                                                                                                                                                               |
| `state/`       | `host-record.ts` values + type tags · `channels.ts` structural journal + state marks · `backing.ts` the `@serverState` accessor pair · `immutable.ts` deep-readonly predicate                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runtime/`     | the creator-facing facades (`Entity`, `Game`, `Player`, `Camera`, `HUD`, `random`, `assets`, `sound`/`music`, `sleep`/`every`/`after`, `request`, motion verbs, wrappers, movement) plus the plumbing: `runtime.ts`, `wiring.ts`, `load-game.ts`, `hosts.ts`, `roster.ts`, `contacts.ts`, `regions.ts`, `lag-ring.ts`, `action-states.ts`, `seams.ts`, `persistence.ts`, `physics.ts`, `prng-store.ts`, `transform-view.ts`, and `movement-pass.ts`, which holds `tickMovement` apart from the decorator-bearing `movement.ts` so the loop's graph reaches no decorator as a value |

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
  settles. The handler is read **inside** the try, since a handler declared as an accessor makes the property
  read itself creator code. Breaker counts are snapshot state; the dedup map is not, and both it and the
  default log are capped so a session cannot grow them without bound.
  Wiring throws are fatal (`LoadError`) because a half-hoisted host record matches no declaration.
- **The same boundary covers creator code that runs without a dispatch**, through `dispatcher.guard(owner,
site, fn)` — one implementation, so the dedup, log and breaker cannot diverge between the two entries. Four
  callers: the movement pass (`tickMovement`, `tick`), a due timer (`timer:<id>`), a tween's write to its
  target (`tween:<id>`) and a countdown's completion (`countdown:<id>`). Each is keyed on the CALLBACK rather
  than on the method that registered it, which has already returned; the owning `ScriptInstance` comes from
  `InvocationScope.owner`, captured at registration, or from `instances.forInstance` for a movement the pass
  holds directly. An unowned callback is contained and logged but cannot be disabled — there is no instance to
  charge.
- **A trip is reported to the host** through `dispatcher.onTrip`, carrying the log record plus the
  `instanceId`, since a class name does not say which of a template's copies stopped. The listener's own throw
  is contained, so a reporting bug cannot end a tick.

## 3. Loop, tick order, snapshot

`step(tick, opts)` is the only entry point — one tick at an explicit index, no clock, `dt` always
`1/simRate`. The accumulator that decides how many ticks a frame owes belongs to the host, which is the only
layer that knows what its clock means; `step` establishes the ambient runtime for the tick. Tick order
(`loop.ts`, passes built in `load-game.ts`):

```
1  adopt tick        rt.tick = the argument, NOT an increment
2  starts            passes.starts — @onStart for everything attached since the last tick
3-4 input            passes.input  — stub in core; installed by the endpoint
5  movement          per player with a movement instance, live avatars only
6  contacts          ContactSource.entered() → @onCollide per tag, both directions
7  regions           RegionIndex.crossings() → @onEnter / @onExit per entity
8  timers & tweens   TimerHeap.advance(), TweenEngine.advance(), then every running Countdown
9  @onUpdate         server + synced locations only
10 destroy drain     @onEnd at every doomed entity, then EntityManager.drainDestroyed()
11 replicate         server only: LagRing.capture(tick)
```

- **Attaching queues a start; the starts pass fires it.** `addScript` from a player-join handler runs
  between ticks, so a `@onStart` dispatched at the attach would run against whatever tick the loop last
  adopted. `InstanceRegistry` keeps the queue in attachment order and `removeHost` drops a torn-down
  host's entries, so a script on an entity destroyed the same tick never starts — the destroy drain has
  already run `@onEnd` there. It is the FIRST pass, so a script is running before anything can dispatch
  to it, and the drain is once-only, so a replayed tick cannot spend it twice. A screen is the one host
  that dispatches its own and drops the queued entries: a menu that appeared but ran nothing until the
  next tick reads as a dropped frame.

- `opts.replay` makes the dispatcher skip client-located handlers and the countdowns pass skip its whole
  advance, since no store rewinds a countdown for a re-run; `EffectSink` is the drop point for one-shot
  effects. `opts.scope` reaches the passes, and `snapshot(scope)` is the only thing that acts on it.
- **An edge is a diff, and the previous tick lives on whatever owns the walk** — the overlapping pair set on
  `ContactSource`, the per-region occupant sets on `RegionIndex`. Neither is a `SnapshotStore`, so a rewind
  leaves both describing the tick they were last folded on; that is why the client honours neither pass.
  `@onCollide` is therefore the moment two bodies touch, with `Entity.getTouching` as the pull-based
  "am I still touching"; a contact has no exit handler.
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
- **Ctor props land between construction and the hoist**, and that ordering is the whole correctness
  argument: the hoist moves each field's authored value into the host record, so a prop written after it
  would be overwritten by the initializer it exists to override. Written there it goes through the accessor
  into the backing map the hoist then reads, so the record — which is what replicates — holds the
  inspector's value. The constructor receives the same map, for a class deriving something that is not a
  field; the engine's write is authoritative for any field the props name. A reserved key is skipped rather
  than assigned, since assigning one rewrites the instance instead of a field.
- **Seeding:** `rt.persisted?.get(hostId, field)` wins over the authored value only when its type tag matches
  (primitive kind, or a one-level shape hash for objects/arrays); otherwise the initializer wins.
- **Host records** live in `HostTable` keyed `game` | `player:<id>` | `entity:<id>` | `camera:<playerId>` |
  `screen:<name>`, each carrying its scope id, values, tags, bound wrappers and `markDirty`.
- **Two replication channels here, one on the store.** `ReplicationChannels` owns the ordered structural
  journal (`spawn` | `destroy` | `reparent` | `tag` | `attach`, plus the `group` that bounds an
  instantiation) and the `(record, field)` state set;
  the **transform** channel is `SimTransformStore`'s own dirty index, which is what lets the server's sink and
  the client's `SceneSink` drain it independently. None of the three is captured by snapshot — they are output
  bookkeeping. `detach()` journals `reparent → NO_ENTITY`; `attachTo` unlinks silently and journals one op.
  `attach` carries the `ScriptId` the running bundle stamped, resolved through `rt.scriptIdOf`, and is
  journaled at entity hosts alone — a class that resolver cannot name is attached locally and journaled
  nowhere, since nothing on the wire can name a class.
- **Wrappers:** `StatefulWrapper` gives `bind(record, field)` (throws if bound twice), `mark()`, and
  `serialize`/`restore`; `Scoreboard`, `Leaderboard`, `Inventory`, `Team` sit on it and mark per key with no
  decorator. An omitted player defaults to the dispatcher's acting-player ambient in `Scoreboard`, and throws
  in `Leaderboard.submit`, which has no one to attribute a bare score to. `Countdown` (own `onZero`, not
  `@onEnd`) and `Storage` (over the `KVStore` seam) sit outside it.
- **A wrapper field's value in `values` is the wrapper itself**, put there by `#bindWrappers` — the same map
  every other field uses, because the replication path reads that map and a wrapper left out of it marks a
  channel whose drain then finds nothing. `serializeHostField` and `restoreHostField` are the two ends both
  endpoints replicate through: the first substitutes `serialize()` (no codec carries a class instance), the
  second calls `restore()` on a wrapper already held, or `reviveWrapper`s one from the payload's own `kind`
  when the receiver holds none — which is the ordinary client, since it runs no scripts. Every constructor
  argument therefore rides the payload: `Leaderboard`'s order decides what `top` means, `Team`'s name is its
  identity, and `Inventory`'s player is resolved through the roster, staying raw when that player is unknown.
- **Persistence is a synchronous cache written through to an async store.** `PersistedState` is what
  `rt.persisted` holds and what wiring's seeding reads, because the hoist is synchronous and cannot await;
  `save(record)` captures the record's fields into the cache **now** and returns the store's promise. The
  asymmetry is deliberate: the boundary that triggers a save is a connection that has already closed, so
  nothing is there to await it, and the capture has to be synchronous because the record is torn down
  immediately after. A host is one KV entry under the `serverState` scope, so a rejoin costs one round trip
  rather than one per field.
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
  immediately; the drain fires `@onEnd` at **every** doomed entity before tearing any of them down — so a
  handler still finds the rest of its subtree addressable — then per entity unparents, clears tags, releases
  the slot, cancels timers/tweens, removes instances and the host, journals `destroy`, and bumps the
  generation.
- **A template is what a spawn key means**, and `instantiate` is logical-now, journaled-as-one — the mirror
  of `destroy`. `TemplateRegistry` holds `@platform/project`'s already-resolved `TemplateDef`s: an id, the
  attachments each instance carries, and the child templates minted beneath it, each with its own local
  offset. It carries no visual, because core draws nothing and the art is keyed by the same `TemplateId` in
  the render manifest. `game.spawn` and `Roster.spawnAvatar` both go through it; a key the registry does not
  hold mints one bare entity, which is what an ad-hoc key has always done. The subtree is a REFERENCE graph
  — a child names a template — so the walk is bounded by `MAX_TEMPLATE_DEPTH` 8 and `MAX_TEMPLATE_NODES` 256
  and a breach is a `LoadError`; the emit is depth-first, each node spawned, attached and parented before its
  own children exist, so parents always precede children.
- **The group bounds replication, never visibility.** Every entity is addressable the moment it is minted,
  exactly as a bare `spawn` is; what the boundary guarantees is that one instantiation's ops cross the wire
  together and in the order they were journaled. It is flat and re-entrant: a child template opens its own
  group and only the outermost produces an op, an empty one journals nothing, and a single op journals
  itself rather than a group of one.
- **`instantiatePlaced` builds the manifest's `entities`** through that same path, in record order, since
  `validate` puts a parent's record ahead of its children's — one pass, no deferred parenting.
- `Broadphase` is naive O(n²) over a `TransformView`, ascending id order, and takes its transform source as a
  constructor argument — the live store or a ring buffer. `liveTransformView` is the one factory for a view
  over the live stores, so `rt.broadphase`'s point-only view and `ContactSource`'s differ in one argument:
  the half-extent lookup. `ContactSource` layers self/parent/child exclusion and tag filtering on top;
  half-extents come from `collider.bounds`.
- `RegionIndex` is build-time named rectangles with point queries; `find({ in })` resolves against it, and
  the regions pass folds live membership through it to get the `@onEnter` / `@onExit` edges.

## 6. Runtime, facades, load order

`Runtime` (`runtime.ts`) is the one mutable slot holding every store, the scope tree, host table, channels,
dispatcher, seams, `tick`, `isServer` and the collaborators `loadGame` fills in. `createRuntime()` /
`withRuntime(rt, fn)` / `clearRuntime()` make the spec's module consts (`game`, `random`, `assets`)
facades over a swappable world rather than process singletons — `game` is a `Proxy` returning methods
**unbound**, so neither the const nor a method read off it captures a stale instance. Anything a facade needs
lives on the runtime and is resolved per call (`assets`, the player lookup behind `Scoreboard.top`), never in a
module slot a second `loadGame` would repoint. Script instances get their runtime stamped at attach time, so
simulation code inside a tick never has to consult the ambient slot at all.

`loadGame(manifest, opts)` → build world (bounds, regions, assets, template registry, collaborators,
`passes`) → attach Game scripts (wire + hoist, **no** `@onStart`) → instantiate the placed `entities` →
`startGame(rt)` drains the first batch of deferred `@onStart`s to each handler's first await →
`joinPlayer` / `leavePlayer` release and end sessions → `endGame(rt)` runs `@onEnd` at every attached
instance, because the world ending ends every host under it. `GameManifest` is `@platform/project`'s
validated narrowing rather than a parallel declaration — `role`, `simRate`, `bounds`, `regions`, `assets`,
`templates`, `entities`, `gameScripts` — so a field added to the authoring shape cannot reach a runtime
without passing through it; `validate` stays the server's to call. `LoadOptions.scriptIdOf` is the one
thing a manifest cannot hold, because it names code: the registry that stamps a class with its `ScriptId`
imports core, so the edge arrives as a function. `leavePlayer` goes innermost host outward and removes last — `@onEnd` at
the player host then its camera host, then `@onPlayerLeave` at the Game, then `PlayerManager.remove`, which
drops both hosts — so every handler can still read the player; `PlayerManager.adopt` keeps a wire-supplied
`index` where `create` mints one.

`hud` is a facade over the current runtime's `HUDState` — the authored screens, the open stack bottom to
top, and one record per widget a verb has written — so it is per-world like `game` rather than a process
singleton. A verb writes the record and pushes the whole of it at the `HUDSink`; `hud.player` is
`rt.localPlayer` and **throws** where there is none, which is any server runtime. `open(name)` mints the
screen on first mention, attaches its registered classes with the props they were registered with, then
marks it visible, drops their queued starts and dispatches `@onStart` itself;
`close(name)` dispatches `@onEnd` and then drops the instances and the host record, so a reopen builds fresh
client state. Both are idempotent, and a screen dispatch names `client` locations explicitly because a
screen exists on one machine whatever role built the runtime. `pressWidget` fires `@onPress` at every
attached instance except a screen-hosted one whose screen the press did not name — which is what keeps two
menus with a `back` button apart — and `pointerHit` fires `@onClick` / `@onHoverEnter` / `@onHoverExit` at
the entity, checking only that it is alive, since the hit was resolved against a camera no authority holds.

A `Countdown` enrols itself on the runtime when `start()` is called and drops out when it pauses or reaches
zero, so the set the countdowns pass walks holds only running ones and a game minting one per round does not
grow it for the session. Its `onZero` runs through `Runtime.guardCallback`, the same boundary a timer
callback gets, because it is creator code with no invocation of its own.

`action-states.ts` is deliberately pure — no runtime, no dispatch — because both endpoints fold input edges
and a second implementation of the one-tick-wide `pressed`/`released` rule would diverge.

## 7. Seams

Each is an interface with a null implementation, so every live member is exercisable in Node.

| Seam            | In core                                                              | Real owner            |
| --------------- | -------------------------------------------------------------------- | --------------------- |
| `Clock`         | `ManualClock` (held on the runtime; the host's accumulator reads it) | host app              |
| `PhysicsSink`   | `NullPhysicsSink` — integrates position, `blocked` all false         | Rapier                |
| `KVStore`       | `MemoryKVStore`, behind `PersistedState`                             | host app              |
| `EffectSink`    | `NullEffectSink` — audio, particles, camera shake                    | client / audio layer  |
| `Broadphase`    | naive O(n²) over any `TransformView`                                 | Rapier or a grid      |
| `ContactSource` | over `Broadphase`                                                    | Rapier                |
| `RegionIndex`   | built once at load                                                   | core (panel-authored) |
| `HUDSink`       | `NullHUDSink` — widget and screen writes                             | client                |

`InputSource`, `SceneSink` and `ReplicationSink` are **not** declared here: the endpoints drive `passes.input`
and read `consumeDirty()` / `drainStructural()` / `drainState()` directly.

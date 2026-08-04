# `@platform/core` — MVP design

Status: **proposed.** Nothing below is built yet.

The runtime every line of creator code runs against: entities, the world, scripts, decorators, the
dispatcher, the loop. No rendering, no network, no DOM. Section references like §3.4 point at
[`api_design.md`](../../docs/api_design.md); line references point at
[`api_spec.ts`](../../docs/api_spec.ts).

---

## 1. Scope

**Core owns** the entity/player/world model and their lifecycles; the script model (bases, decorators,
attachment, hoisted `@serverState`); handler dispatch, ordering, concurrency and cancellation; the
fixed-step simulation loop and the tick counter; timers and the tween engine; tags, queries and
regions; the data wrappers; K/V storage and `@serverState` persistence.

**Core does not own** the canvas or any draw call (`@platform/renderer`); the frame clock — core is
_pumped_, never self-driving (§8.1); serialization, replication and reconciliation
(`@platform/server` / `@platform/client`); input device capture; collision _geometry_ (Rapier); audio
output. Each is a seam (§10) with a null implementation, so core is testable in Node with no clock, no
canvas and no network.

**Core vs. math:** if a declaration names an engine object or panel-authored data it is core;
otherwise it is `@platform/math` (§11.1). `lerp` is math, `tween` is core; the seeded generator is
math, `random.pointIn` is core.

---

## 2. What gets built, and how completely

| Tier                 | Meaning                                                              | Behaviour when called        |
| -------------------- | -------------------------------------------------------------------- | ---------------------------- |
| **A — full**         | The deliverable. Complete semantics, tested.                         | works                        |
| **B — load-bearing** | Not requested, but tier A cannot function without it, so it is real. | works                        |
| **C — shell**        | Typed surface, no behaviour. Awaits a package core does not own.     | documented no-op, or `throw` |

The tier is stated per member because "shell" has meant two different things in this repo.

**Tier A.** `Entity`, `Player`, `Game`; the loop and tick counter; `@onStart` / `@onEnd`; `Storage` +
the K/V layer and `@serverState` persistence; the wiring and loading functions.

**Tier B.** The decorator registry and _every_ decorator's registration — a handler table that omits
`@onCollide` cannot be validated at load, so all of them register even where dispatch is dormant; the
four script bases; the dispatcher with concurrency and cancellation; `@serverState` hoisting; `sleep` /
`every` / `after`; the tween engine and every `Entity` / `Camera` motion verb; tags, `find`, regions;
`Ctx`; destroy cascade; `Random`; `Countdown` (the loop ticks it); the wrapper base plus `Scoreboard`,
`Leaderboard`, `Inventory` and `Team` on it (§5.2 — in-memory, with `Leaderboard`'s persistence on the
`KVStore` seam); `Collider` / `Animation` as template-configured data records.

**Tier C.** `HUD`, `HUDScreen`, `Cursor` (need a client); `Asset` / `assets` (panel-loaded); `sound` /
`music`; `request` / `@onRequest` (need transport); `Camera.viewport` (needs a window); `Entity.play` /
`playEffect` / `stopAnimation`.

**An `Animation` record with no playback** holds `speed` and reports `clip` as `''` (api_spec.ts:162) —
the spec's documented nothing-playing value, so a creator branching on it gets an answer rather than a
crash. Absent is the state machine deriving a clip from velocity and `blocked`, which is the renderer's
frame selection (renderer DESIGN §1). `Collider` is fully live: its `bounds` and flags feed the
`Broadphase`.

**Two members sit between B and C**, because a pure shell would make a tier A member dishonest:

- **`BaseMovement`, `TopDownMovement`, `PlatformerMovement`.** Stages 1–3 of the sealed tick (§4.1) are
  real; stage 4, `move()`, delegates to a `PhysicsSink` (§10) whose null implementation integrates
  position and sets `blocked` all-false. A platformer runs and falls; it does not land. Rapier fills the
  same seam later.
- **Contacts.** `getTouching` / `isTouching` / `@onCollide` / `@onEnter` / `@onExit` run against a
  `ContactSource` over the `Broadphase` below. **Cost:** O(n²) per tick, no rotation, no sub-AABB
  shapes. It keeps `getTouching` from being a permanently empty array, and is the one place core
  computes geometry it will later delegate.

**One `Broadphase`, three consumers:** the contact set, `find({ near })`, and per-player interest
scoping when replication needs it. One index over entity AABBs that all three query, so it is not
written three times and optimized once — the naive implementation satisfies the same interface, making a
grid or Rapier-backed index a substitution rather than three rewrites. Its iteration order must be
stable for determinism (§1.2), which is easier to guarantee in one place than three.

`Bounds`, `Vec3`, `Easing`, `clamp`, `lerp` and the seeded stream stay in math, re-exported (§9).

---

## 3. The script model

### 3.1 Location is a base class; host is not knowable at runtime

- **Location** is the base class — a prototype-chain walk, real runtime information.
- **Host** is a type parameter, erased. Nothing at runtime reads `<Entity>` off `SyncedScript<Entity>`.

The erasure costs nothing: **the host kind comes from the attach site.** `entity.addScript(C)` attaches
to an `Entity`, so the grid cell checked is (location from the chain) × (host kind from the target). The
type parameter only types `this.host`, and TypeScript already rejects a mismatch since `Entity.addScript`
accepts only `new () => BaseScript<Entity>` (api_spec.ts:260). Compile time catches "wrong host"; wire
time catches "illegal cell". Neither needs a decorator argument naming the host.

### 3.2 The registry

Two per-class tables on the class's decorator metadata object:

```
HANDLERS:  metadata.handlers   HandlerDecl[]     { event, kind, methodName, opts }
STATE:     metadata.state      Set<fieldName>
```

**Metadata objects inherit prototypally** (`Object.create(baseMetadata)`), so **a subclass inherits its
parent's declarations and an override does not re-register** — the `DoubleJump` rule in §4.1 falls out
rather than being implemented. Declarations key on _method name_ and dispatch calls `inst[name]`, so the
subclass's body runs under the parent's registration. Verified: `DoubleJump extends Movement` with
`override jump()` and no second decorator collects exactly one `jump` declaration and dispatches to the
subclass's body.

Writes are **copy-on-write** — a decorator finding `handlers` inherited rather than own clones it before
pushing. Verified: a sibling subclass adding `dash` leaves the base at `["jump"]`.

`Set` and `[]` are insertion-ordered and collection walks base→derived, which makes dispatch order
engine-stable (§1.2) without a sort.

### 3.3 Standard decorators, contained to one file

The spec declares **standard (TC39 Stage 3) decorators** — one `(value, context) => replacement | void`
shape (api_spec.ts:847, :854). Only `script/decorators.ts` knows how a `HandlerDecl` was produced; the
registry, dispatcher, wiring and hosts store a neutral record, so nothing in §4–§8 depends on the
decorator model.

Probed against this toolchain (TypeScript 7.0.2, node 24.16.0):

|                         | Result                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| api_spec.ts as written  | **compiles**, no `experimentalDecorators`                                 |
| Both sample games       | **typecheck clean** against it — 57 decorator usages across 8 of 10 files |
| Creator-facing syntax   | **identical** to legacy — no game file changes                            |
| Registry key            | `context.metadata`, prototypally inherited (§3.2)                         |
| `Symbol.metadata`       | **absent on node 24** — needs a one-line polyfill                         |
| `@serverState` hoisting | verified end to end (§5.2)                                                |
| Config                  | `lib` gains `esnext.decorators`; **no** `experimentalDecorators` anywhere |

**Legacy is rejected on correctness, not preference.** A legacy property decorator is `(target, key)`
where `target` is the **prototype** — it never sees an instance and has no value to wrap. Under
`useDefineForClassFields` (the ES2023 default this repo builds with) the class field `[[Define]]`s an own
property shadowing any prototype accessor the decorator installed, so writes are never observed: measured
directly, a legacy `@serverState` left its dirty set **empty** after a write, with its backing variable
shared across all instances. The standard field decorator returns an **initializer** running per instance
with the authored value, which is what §5.2 needs and legacy has no equivalent for.

**The one cost:** `Symbol.metadata` does not exist on node 24.16.0, so `context.metadata` arrives
`undefined` and the registry silently collects nothing. Core installs
`Symbol.metadata ??= Symbol('Symbol.metadata')` at the top of `script/decorators.ts`, and `lib` gains
`esnext.decorators`. Verified: with the polyfill the registry collects and inherits; without it every
table is empty.

Rejected alternative: `addInitializer` + `getPrototypeOf(this)` to keep a `WeakMap<prototype, …>` and
avoid the polyfill. It **double-registers** — the initializer runs per instance and `this` is the
most-derived instance, so constructing a base and a subclass collected `jump` twice. Guarding it
correctly means reconstructing the own-vs-inherited distinction metadata already gives free.
`addInitializer` is still used for recording a declaration's field name and per-instance wiring (§5.2).

### 3.4 What wire time rejects

Structural checks run when a script is attached — which for the panel path _is_ load time, since
templates wire before any `@onStart` (§8.1):

| Rejected                                                            | Because                                           |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| `SyncedScript<Camera>`, `SyncedScript<HUDScreen>`                   | no authoritative copy to reconcile against (§1.1) |
| `ServerScript<HUDScreen>`                                           | a screen exists on one machine                    |
| `@onRequest` off a `ServerScript`                                   | the trust boundary is the base class (§5.9)       |
| `@serverState` on a `ClientScript`, on any host                     | "replicate a client's belief" (§6.1)              |
| `@serverState` on a `Camera` or `HUDScreen` host                    | client-owned presentation (§6.1)                  |
| `@serverState` on a wrapper instance                                | already authoritative; marks per-key (§5.2)       |
| two scripts on one host declaring one name                          | hoisting is not a merge and not a shadow (§6.1)   |
| `BaseMovement` on an entity with no owner                           | movement is player-only (§4.1)                    |
| `@onPlayerJoin` / `@onPlayerLeave` off a Game-hosted `ServerScript` | roster events (§5.2)                              |
| `'release'` / `'hold'` on a creator-sent event                      | a send is instantaneous (§5.3)                    |
| `BaseScript` extended directly, or an abstract base attached        | names no location (§1.1)                          |
| overriding `BaseMovement.tick`                                      | the order is the prediction contract (§4.1)       |
| `asSeen` on a spatial query in a `SyncedScript`                     | the ring is server-only (§8.1)                    |
| `asSeen` outside an input-originated handler                        | no view tick to key the read against (§8.1)       |

The duplicate-name check walks §5.2's field trichotomy: decorated fields and wrapper instances claim
names on the host, local fields claim nothing.

**Source-level determinism is out of scope for this build.** `Math.random` in a `SyncedScript`, a
`camera.viewport` read from synced code, and `hud` from a `ServerScript` are properties of a function
_body_, so catching them at load needs a TypeScript AST pass, which belongs beside the panel's type
emission rather than in the runtime. Until it exists each throws at runtime with the message the load
error will carry, so the diagnostic text is written once. Tracked in §12.

---

## 4. Dispatch

### 4.1 Synchronous to the first await

`send` invokes every matching handler; each runs to its first `await` before `send` returns, and the
returned promise settles once all finish (§5.8). So `crate.send('break')` followed by `crate.alive`
reads `false` when the handler had no await — which is the contract, and which forbids a deferred-signal
model. Dispatch is a synchronous loop collecting promises.

### 4.2 Concurrency

Three modes (§5.7), per-event defaults, **lock per script instance** — not per method, which is the lazy
implementation that makes player 1's cooldown gate player 2 and is invisible in single-player testing.

| Event                                                                       | Default      |
| --------------------------------------------------------------------------- | ------------ |
| input press/release/hold, creator-sent, `@onUpdate`, `@onClick`, `@onPress` | `ignore`     |
| `@onCollide`, `@onEnter`, `@onExit`                                         | `concurrent` |

`restart` cancels the running invocation at its next await point. No `queue` mode (§5.7).

### 4.3 Cancellation, and how an awaitable finds its host

A three-level scope tree: **runtime → host → invocation.** Destroying a host cancels its invocations;
`restart` cancels one; every engine awaitable registers with the innermost live scope.

`sleep()` must know which invocation called it, and an ambient set at dispatch entry is lost after the
first `await` — there is no `AsyncLocalStorage` in a browser. **The engine's own awaitables restore the
ambient as they resolve**, which works because the awaitable surface is closed and engine-owned —
`sleep`, the motion verbs, storage reads, `send` (§9.1) — so core controls every resumption point in
creator code.

**Limit:** awaiting a promise core did not hand out (a bare `Promise.resolve()`, a `fetch`) loses the
ambient, and a later `sleep` falls back to the _host_ scope. It still cancels with the host, so nothing
leaks past a destroy; it stops participating in `restart`.

**The watchdog counts program events, never time.** A wall-clock budget ("this tick took over 50ms, kill
it") is itself a desync source: a school Chromebook and the server do not take the same time on the same
tick, so the client trips at 50ms, aborts the handler and continues while the server finishes it — same
tick, same inputs, divergent state, and it fires precisely on the slow hardware creators use. So the
watchdog counts **loop back-edges** and **dispatch depth**, which are properties of the program and reach
their limit at the same point on every machine or on none. Same reasoning as §9.1: a rule allowed to
differ per machine cannot sit inside the synced window.

Back-edge counting needs instrumentation over creator source, so it ships with §3.4's AST pass and is a
**TODO** (§12). Dispatch depth is available today and is implemented now, covering `send` recursion
(§5.8). Until the pass exists, a synchronous infinite loop hangs the tick rather than aborting it — worse
than the wall-clock version, but not divergent.

### 4.4 Creator exceptions

**Status: TODO.** api_design.md §14 is the contract; this is what core owes it. Today a throw from a
handler has no defined outcome.

**The invocation is the unit of failure, never the tick.** A `try`/`catch` sits where a handler is
invoked, so an exception is logged and the rest of the tick proceeds — other handlers on the event, other
entities, the loop. Wrapping the tick would convert a local bug into a global stall and bury the cause.

The log record is fixed: **script class, method, host id, tick, event name, stack**. The tick number is
correct because `step` takes it as an argument (§8.1); an ambient counter could drift from the tick that
threw.

- **Deduplication.** Identical errors — same class, method, message — collapse to one entry with a count.
  Without it an `@onUpdate` that throws emits sixty records a second and hides every other error.
- **A circuit breaker at ~100 _consecutive_ throws** disables that handler and logs the disabling as its
  own prominent record. Any successful invocation resets the counter, so a handler throwing on rare input
  is never disabled. The threshold is an engine constant, not a creator knob.

**The breaker's counter is simulation state and registers with the snapshot** (§8.1). A per-handler throw
count decides whether code runs, so an unrestored counter means a replay hits a different count than the
original run and a handler disabled at tick 99 stays disabled through a replay that should have reset it
at 97 — §4.3's failure class arriving through the error path. Two consequences: the counter increments on
throws and nothing else (not elapsed time, not retries), and it is per `(instance, method)` like the
concurrency lock, so one player's broken handler cannot disable another's.

**The dedup map is not snapshot state.** Dedup affects only console output, so a replay double-counting a
log line is cosmetic; the breaker affects whether a handler runs. Log concerns stay out of the snapshot,
control flow goes in.

**Wire and destroy-drain exceptions are fatal.** The dividing line is whether core can describe the state
it is left in. A handler is a leaf — it ran or it did not. Wiring is not: a script whose `@serverState`
installed three of five accessors (§5.2) leaves a host record matching no declaration, and an entity
half-removed from the tag index, contact set and renderer is a dangling reference the next tick reads.
Continuing produces a second, unrelated failure — the one the creator would report. Both abort with the
same fields plus the phase.

The general rule: **catch where the failure is local and the state coherent; abort where it leaves a
structure half-mutated.**

---

## 5. State

### 5.1 Host records and the three replication channels

`@serverState` lives on the host, not the declaring script (§6.1). One record per host — game, player,
entity instance — holds the values. Core marks, `@platform/server` drains, nothing in core serializes.

**One dirty set is the wrong shape.** Server→client traffic is three populations differing by two orders
of magnitude in volume, in delivery requirements, and in what a mark must say. Every mutation path writes
to exactly one; merging them later means reopening all three.

| Channel        | What marks it                                  | Volume                  | Delivery                        | Mark structure                                |
| -------------- | ---------------------------------------------- | ----------------------- | ------------------------------- | --------------------------------------------- |
| **structural** | spawn, destroy, reparent, tag, script attach   | low, bursty             | **ordered, reliable**           | an append-only journal of events              |
| **transform**  | every `move()`, every tween, every motion verb | every mover, every tick | **lossy is correct**            | a dense per-entity bitset over the SoA arrays |
| **state**      | a `@serverState` write (§5.2)                  | low                     | **reliable, per-player scoped** | a set of `(hostRecord, fieldName)` pairs      |

- **Structural must be ordered and reliable:** the operations do not commute — destroy-then-spawn and
  spawn-then-destroy leave different worlds, and a client missing a spawn holds a dangling parent for
  every child that followed. A journal preserves order; a bitset cannot express it.
- **Transform is the only high-volume channel and the only one that may drop.** A superseded position is
  worthless: the next snapshot carries the current one and the client interpolates between snapshots
  anyway (§1.2). One bit per entity, cleared each send, no history — a mover dirtied sixty times between
  sends costs one bit and sends one value.
- **State needs per-player scoping**, which neither other channel does. `@serverState` on a Player host
  replicates to that player alone (§6.1), so the drain answers "what does _this_ connection get" — keyed
  by host record, not entity index. It is also the only channel whose unit is a named field.

`ReplicationSink` (§10) exposes three drains. Core's obligation is that every mutation marks the right
channel; the sink decides cadence. `sendRate` (§1) applies to the transform channel — the other two flush
on the next send regardless, being small and reliability-bearing.

**A `ClientScript` marks nothing** (§1.2), so the channels are a server-side structure a local run does
not drain.

**The transform bitset has two independent drains, safe only while there are two core instances.** The
server's `ReplicationSink` drains it; the client's `SceneSink` drains it to pick renderer nodes to patch.
Both clear the bits they consume, so a single core serving both roles would have whichever drains first
steal the other's marks — the renderer missing moves, or the network. Networked runs are separate
processes and loopback runs are separate core instances (§8.4), so nothing is shared today. Recorded
because "optimize local mode to a single core instance" would break rendering or replication **silently**;
the fix would be one bitset per drain.

### 5.2 A `@serverState` field is never a data property

A plain data property can be written without the engine noticing, and an unobserved write never
replicates and never persists — silent, in the direction that loses a player's progress. So
`@serverState` compiles to an **accessor pair**: the getter reads the host record, the setter writes it
and marks the state channel (§5.1).

```ts
@serverState credits = 0;

this.credits = 2;        // setter -> host record + state mark
this.credits += 1;       // getter, then setter -> marked again
player.credits = 5;      // the hoisted accessor on the host — same record, same mark
```

Every write form routes through the setter, including compound assignment and `++`, since both are
defined in terms of it.

**"Read-only" means the _field_ never holds the value, not that the property is `readonly` to a creator.**
Writing `@serverState` is the normal way to change authoritative state — `this.health -= 1` in a damage
handler, `ctx.player.credits -= cost` in `@onRequest` (api_spec.ts:1090) — so typing it `readonly` would
break both. The accessor removes only the _unobserved_ write. Contrast `Entity.position` (§6), where the
write is genuinely forbidden and routed to a named setter.

#### The mechanism

Standard field decorators cannot install an accessor directly. What makes it possible: `addInitializer`
on a _field_ context runs **after** the field is defined (measured — the field is already an own property
when the initializer body runs). Against the spec's `StateDecorator` shape (api_spec.ts:854):

1. the returned initializer receives the **authored value** and passes it through — one evaluation, no
   marking;
2. `addInitializer` reads that own value off the instance, `delete`s the data property, and
   `defineProperty`s the accessor pair in its place;
3. the record is seeded with the persisted value **if its type tag still matches the declaration**, else
   the authored one — a valid restore beats the initializer, and the seed writes the record directly
   rather than through the setter, or every field would be dirty at construction;
4. the hoisted accessor on the host (§6.1) is installed against the same record, so `this.credits` and
   `player.credits` are one value.

Verified end to end: initial read returns the authored value, a persisted field restores over its
initializer, `+=` fires the setter, the record shows the written value, the state channel holds exactly
one mark per write, an inherited declaration hoists, and a plain field stays a plain own property. The
instance ends with **no data property** for the field — the invariant a test asserts directly.

Two rejected alternatives, both measured. A **prototype accessor at decoration time** requires
`useDefineForClassFields: false` repo-wide and silently fails to hoist without it (§3.3). Returning the
value from the initializer **without** step 2's swap leaves a data property: reads work, writes vanish —
record still `5` after assigning `42`, dirty set empty.

#### Step 3's type tag

A restore is data from a previous version of the game, and `persisted[key] ?? authored` trusts it
blindly. Both things creators do between sessions break silently: renaming `coins` to `credits` leaves an
orphan `coins` and a `credits` that restores nothing; changing `@serverState level = 1` to
`level: Phase = 'lobby'` restores the number `1` into a field every reader treats as a string. Neither
throws.

So each persisted field stores a **tag** — the declaration's primitive kind, plus a shape hash for a
readonly object or array — and restore compares before seeding. **On mismatch the stored value is dropped
and the initializer wins**, with a load-time warning naming the field, the stored tag and the declared
one. The authored initializer is by construction a valid value of the declared type, so the game starts
in a state its own code expects; preserving a mismatched value cannot promise that, and throwing would
make a rename a hard failure for every existing save. The rename case is still data loss — no migration
story in MVP (§12).

#### The type must forbid mutable values

The accessor observes only _assignment_. `this.scores.push(x)` and `this.config.hp = 20` never reach the
setter: they mutate an object the record already holds, so the value changes and the channel is never
marked — the same silent failure, through a door the accessor cannot watch.

So **a mutable declaration fails to compile.** The decorator's `Value` passes through an immutability
predicate; on failure the context type collapses to a branded marker the real field type cannot satisfy:

```ts
@serverState left = 60;                              // ✓ primitive
@serverState phase: Phase = 'lobby';                 // ✓ string union
@serverState board: readonly Row[] = [];             // ✓ readonly, deeply
@serverState scores: number[] = [];                  // ✗ mutable array
@serverState config: { hp: number } = { hp: 1 };     // ✗ mutable object
@serverState ammo: Record<K, number> = {};           // ✗ mutable record
```

Verified: all three rejected forms error at the decorator with the branded message; readonly arrays,
readonly records and deeply-readonly element types pass; a mutable element inside a `readonly` array is
still rejected, so the predicate recurses rather than checking the outer layer only.

**Replacing a whole readonly value is the intended write**, as the samples already do:
`this.board = this.wins.top(5).map(…)` assigns a fresh array, firing the setter once. The cost is copying
rather than patching in place, which is right at this channel's volume (§5.1) — a whole-value copy of a
leaderboard row set is nothing beside the transform channel it shares a tick with.

**The samples hold exactly the bug this forbids.** `@serverState ammo: Record<WeaponKey, number>`
(`battle-royale/player.ts:28`), written as `me.ammo[key] -= 1` (`fighter.ts:51`), mutates the host record
without marking, so a client never sees the ammo count change. Under this rule it does not compile; the
fix is `Inventory`, a per-player keyed count. Reported in §12 rather than silently patched.

#### Three kinds of field

| Kind               | Declared as                    | Authoritative?  | Marks the channel |
| ------------------ | ------------------------------ | --------------- | ----------------- |
| decorated          | `@serverState`, immutable type | yes             | the setter        |
| a wrapper instance | any wrapper-base subclass      | yes, implicitly | its own methods   |
| local              | anything else, no decorator    | no              | nothing           |

**Wrapper instances are authoritative with no decorator.** They are engine classes whose methods already
mark the channel, so there is nothing for a creator to remember — `scores.add(1)` replicates because
`Scoreboard.add` marks. It is also a better shape than a decorated array: a wrapper marks **one key**
where a `readonly` value copies the whole thing. The samples read this way already —
`readonly wins = new Leaderboard(…)` and `readonly clock = new Countdown(ROUND)` in
`battle-royale/game.ts` carry no decorator and are expected to persist.

This requires **one exported base shared by the four stateful wrappers** — `Scoreboard`, `Leaderboard`,
`Inventory`, `Team` — so "is this field authoritative" is an `instanceof` rather than a class-name list to
keep in sync, and a creator subclass inherits the marking. The spec declares the four independently
(api_spec.ts:972–1004) with no common ancestor, so this is a **spec addition** (§12). `Countdown` and
`Storage` stay outside it: a countdown is derived from the clock, and `Storage` is the key-value escape
hatch rather than replicated state (§6.3).

#### The base is a contract, not just an `instanceof` target

`readonly wins = new Leaderboard(…)` runs as a field initializer, when there is no host, no host record
and no field name. Four questions follow:

| Question                                       | Why the constructor cannot answer it                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| What does it mark?                             | §5.1's unit is `(hostRecord, fieldName)`; it knows neither                    |
| How does it persist?                           | §5.3 keys off the record via the declared-name set, which wrappers are not in |
| What is its type tag?                          | step 3 compares a primitive kind or shape hash; a wrapper has neither         |
| What if one instance is assigned to two hosts? | nothing stops it, and it would mark against whichever bound last              |

So the base declares **`bind(record, fieldName)`**, called by wiring, plus a `serialize` / `restore` pair:

- **`bind` supplies the missing identity.** Wiring walks the instance's own fields and binds every
  wrapper — the same walk that installs accessors for decorated fields, so wrappers are not a second
  discovery path.
- **`bind` throws if already bound**, closing the two-hosts question by construction. Sharing one
  `Leaderboard` between two players is a load-time error naming both sites, not a silent mis-marking that
  surfaces as one player's score on another's record.
- **`serialize` / `restore` give persistence and tagging one interface.** The wrapper decides its own wire
  form, so §5.3 checkpoints it without knowing what a `Team` is, and the type tag becomes class identity —
  unambiguous, unlike a shape hash over a class with methods. A `Leaderboard` restored where an
  `Inventory` is now declared is the same drop-and-warn as any other tag mismatch.
- **Marking stays per-key**, since `bind` hands over the record and field name: `scores.add(1)` marks
  `(record, 'scores')` with the key it touched.

**An unbound wrapper throws on first use.** One constructed in a handler and never assigned to a field —
`const t = new Team('red')` — has no record to mark and no way to persist, so its methods throw pointing
at field assignment. It is the one case the wire-time walk cannot catch.

### 5.3 Persistence

`@serverState` _is_ the persistence mechanism (§6.3): every value is checkpointed against its host record
and restored next session, with no `@persist` to remember. Game state keys off the game record, player
state off the player's.

**Two field kinds are checkpointed by the same walk over the host record.** Decorated fields checkpoint
their value with §5.2's type tag; bound wrappers checkpoint whatever `serialize` returns, tagged by class
identity. `Leaderboard`'s `persist: false` (api_spec.ts:981) is the model's only opt-out, and exists
because a session-scoped scoreboard is a real thing while session-scoped `@serverState` is not (§6.1).

**Entity-instance persistence is a spec gap** (§12): a runtime-spawned entity has no identity surviving a
session, so "that instance's record" (§6.1) has nothing to key on. Recommendation: persist only
panel-placed entities, keyed by authored id; runtime-spawned state is session-only, warned about at load.

### 5.4 Storage

`Storage` (api_spec.ts:965) over a `KVStore` seam, with an in-memory implementation in core and
`player.storage` scoped by player id. Reads are `ServerScript`-only (§1.2) — enforced at runtime now, at
load once §3.4's AST pass exists. `Leaderboard` sits on the same seam.

---

## 6. Entity

Full (api_spec.ts:174). The non-mechanical decisions:

**The transform is readonly and reads return values, not aliases** (§3.1). `position` hands back a copy,
so a read stays valid after the body moves. Engine hot paths use `positionInto(out)` and the store
directly, matching the renderer's out-param style.

**Hierarchy carries position only.** Rotation, scale and opacity do not inherit — the renderer's rule
(renderer DESIGN §5), and the two must compose identically or simulation and picture disagree. It also
composes unchanged in 3D: vector addition, no matrix.

**`destroy()` is logical-now, teardown-at-end-of-tick.** `alive` flips false immediately, so §5.8's
`crate.send('break'); crate.alive === false` holds, while removal — renderer node, contacts, scripts,
children — drains in the tick's destroy phase. This is Unity's end-of-frame `Destroy` split, and it stops
a mid-dispatch destroy from mutating the list being iterated.

**Storage is structure-of-arrays with generation-packed handles**, reusing the renderer's `node-id`
pattern (renderer DESIGN §7): a stale `Entity` reference is a no-op rather than a crash, and iteration
order is creation order — the engine-stable order determinism requires.

**Timed motion verbs are all one tween** (§9.1), so cancellation, easing, awaitability and
last-one-wins conflict resolution are defined once. `tween` is the shared implementation and stays out of
the palette.

**Tags are an index**, `name → entity set`, so `find({ tag })` is a lookup rather than a scan — Roblox's
`CollectionService` shape, and what keeps §5.4's "`getTouching` costs what `blocked` costs" true.

---

## 7. Player and Game

**`Player`** (api_spec.ts:352) is identity and outlives the avatar. `index` is assigned by the roster and
stable for the session. `spawn` / `respawn` / `spectate` / `teleportTo`, where `teleportTo` raises the
prediction-reset flag the client reads (§3.2). `movement` / `setMovement` attach an Entity-hosted script
to the avatar while the accessor lives here (§3.2, §4.1).

**Checkpoint location is a spec TODO** (api_spec.ts:368, §12). Recommendation: engine-internal on the
`Player`, set by `spawn()` and by entering a panel-marked checkpoint region, defaulting to the template's
spawn point, so `respawn()` is meaningful in a game that never mentions checkpoints.

**`Game`** (api_spec.ts:488) is the session and the world. It owns the entity table, the template and
region registries, the roster, the loop, and global `@serverState`. `bounds` is build-time and readonly,
which is what lets `load()` not exist (§3.4). `spawn` is synchronous and always safe; `find` returns a
real array; `pause` / `resume` gate the loop's sim advance in local modes only.

`abstract class Game` in the spec means `new Game()` is a compile error while the engine builds the one
instance. Core's concrete class is not exported.

---

## 8. The loop

### 8.1 `step()` is the primitive; `advance()` is a loop over it

`dt` inside a sim tick is always exactly `1 / simRate`, never a measured frame time — §1.2's
fixed-timestep rule made structural.

**A clock-driven `advance()` cannot be the primitive**, because the two callers that matter have no
clock: reconciliation re-executes ticks 96–100 inside a single frame with **no time elapsed** (§1.2), and
the determinism harness replays a recorded input sequence as fast as it can. Both need "run exactly this
tick with exactly these inputs".

| Entry point                | Meaning                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `step(tick, inputs, opts)` | execute **one** tick at an explicit index. No clock. The primitive. |
| `advance(elapsedSeconds)`  | fixed-step accumulator; a thin loop calling `step` per drained tick |
| `frame(dt)`                | display-rate `@onUpdate` on `ClientScript`s only (§12.2). No sim.   |

`step` taking its tick index rather than incrementing a counter is what makes a replay a replay:
anything reading "the current tick" reads the argument. `advance` keeps the accumulator and the `Clock`
seam, so ordinary hosting is unchanged.

#### `opts.replay` suppresses one-shot effects

A rewind re-executes ticks 96–100, so every `@onEvent` press, `@onCollide` and `every()` in that window
fires again. Simulation state is fine — that is what determinism buys. **One-shot effects are not:**
`sound.play`, `playEffect`, `camera.shake`, a HUD write and any `send` reaching a `ClientScript` handler
each fire once per mispredict, so on a lossy connection the jump sound plays five times in a frame.

The test is **idempotent-by-state or one-shot**, not "is it visual":

| Replayed call                                                             | Suppressed | Why                                               |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| `sound.play`, `music.play`, `playEffect`, `camera.shake`, `hud.*`         | **yes**    | fires again each time; nothing reconciles a sound |
| transform writes, `@serverState`, `say`/`think` text, tags, spawn/destroy | no         | state — a replay writes the same value            |
| dispatch to a `ClientScript`-located handler                              | **yes**    | client handlers are where one-shot effects live   |

`say` is the instructive row: it looks like an effect and is replicated entity state (§3.7), so replaying
it rewrites the same bubble harmlessly. Sound is the opposite. Sorting by "visual or not" gets both wrong.

**A flag on `step`, not a mode on the runtime**, for the same reason the tick index is a parameter: an
ambient `isReplaying` can be read at the wrong moment by a nested call, a queued timer or a parked
continuation, while a value threaded from `step` is scoped to the work that tick did. The effect-shaped
seams — `AudioSink`, `EffectSink`, and the tier C shells as they land — take it and drop the call.
`advance` passes `replay: false`.

**This lands before any effect call site exists.** Retrofitting means visiting every one, and the bug it
prevents is invisible in single-player testing, where nothing mispredicts.

#### `snapshot()` / `restore(s)` live in core

A replay must restore the state it replays from, and that state is core's private structures: the SoA
transform arrays, the tag index, the timer heap, the tween list, the id allocator's freelist and
generation counters, the contact set, the host records. Nothing outside core can reach any of it, so a
client-side reconciler cannot assemble a snapshot from the public surface. Rewind is `restore(snapshot)`,
`step` forward over the unacknowledged inputs, and land at a corrected present — the §1.2 sequence.

**Completeness is a registry, not a discipline.** The list above must not be a hand-written list: the
build order adds the `Broadphase` at step 6, host records at 7 and the KV layer at 8, and forgetting one
produces a rare playtest desync — the worst failure mode this design has. So **each store registers with
the runtime and exposes `capture(into)` / `apply`**, and `snapshot()` iterates the registry. A new store
either registers or the coverage test fails. Same argument as §5.1: make the wrong thing impossible
rather than remembered.

**`capture` takes an out-param**, matching the renderer's style (`vec3Set(out, …)`,
`localTransformOf(id, out)`). The scoped snapshot runs every frame on the client — the one hot path in
this design on hardware we do not control — so a fresh object graph per store per frame is GC pressure
during exactly the gameplay that made the rewind necessary. A reconciler holds one buffer and refills it.
The store interface is the only place to decide this, since retrofitting changes every `capture`
implementation at once. The unscoped form allocates freely: harness and tests only.

**The three channel marks are deliberately not captured** (§5.1). They are output bookkeeping — a record
of what a consumer has yet to drain — not simulation state. Restoring them would be actively wrong on the
client, where `SceneSink` drains the transform bitset: rewinding it to tick 95's marks discards moves the
renderer had not drawn, so the picture silently loses frames the simulation made. Leaving them alone means
a replay adds to a live set, which is consistent — the marks say "these entities changed since the last
drain", still true of exactly those entities after a rewind-and-replay.

#### `step` is scoped by the same set as `snapshot`

`snapshot(scope)` rolls back five entities; if `step` then advances all four hundred, the unscoped ones
are five ticks ahead of themselves and any contact between the predicted avatar and one of them reads
that. So `opts.scope` names the **simulated set**, identical to what the scoped snapshot captures.
Everything outside it is not stepped on the client: no movement tick, no `@onUpdate`, no timers — its
transform changes only when a snapshot is applied.

**The location filter cannot deliver this.** Location is per-script (`SyncedScript` vs `ServerScript`);
the simulated set is per-**entity-ownership**. A coin's `SyncedScript` is synced code on an entity the
client does not own, so location says "run it" and ownership says "do not".

**The predicted avatar collides against the last authoritative snapshot, not the interpolated position.**
Both halves of that:

- **Core's transform store holds simulation state only.** For a predicted entity that is the stepped
  value; for a non-predicted one it is what the last applied snapshot wrote, and it sits still between
  snapshots. Simulation never reads a presentation value, which keeps `getTouching` and `blocked` meaning
  the same thing on both machines.
- **Interpolation is a separate client-side buffer that never writes back.** It holds the previous and
  next snapshot per non-predicted entity and produces a display position at render time. `SceneSink`
  remains the render path for every entity; what differs is its _source_ — the transform store for the
  predicted set, the interpolation buffer for everyone else. `@platform/client` owns the buffer.

**Cost:** the avatar collides against positions up to one send interval stale — 50ms at the default
`sendRate` of 20 (§1). That is the standard client-prediction trade, and the server's copy is
authoritative, so a disagreement is corrected by the next snapshot. Colliding against interpolated
transforms instead would make contact results depend on render timing, so two clients at different frame
rates would predict different collisions from identical inputs — a desync by construction, worse than
being 50ms stale.

This tightens api_design.md:207 (§12), which reads as though interpolation writes the value collision
reads.

#### Two snapshot forms

A client predicts only the entities it owns — its avatar, mostly — and interpolates the rest without ever
stepping them (§1.2), so the per-frame snapshot needs the predicted set rather than the world:

| Form              | Contents          | Caller                            | Cost            |
| ----------------- | ----------------- | --------------------------------- | --------------- |
| `snapshot(scope)` | the predicted set | the client, every frame           | small, hot path |
| `snapshot()`      | everything        | the determinism harness and tests | irrelevant      |

**Neither form's caller is the server through `restore`** — the authority cannot roll itself back without
cancelling the live invocations that asked. But `capture` has a server-side caller — the historical query
(below), which reads past state without touching the present — so snapshotting is not purely a
client-and-test concern.

**`scope` is entity-keyed and most stores are not**, so each registered store declares one of three
scoping modes — **filtered**, **whole**, or **derived**:

| Store                      | Under `snapshot(scope)`                                               |
| -------------------------- | --------------------------------------------------------------------- |
| SoA transforms, tag index  | filtered by entity id                                                 |
| timer heap, tween list     | entries **owned by** a scoped entity, via §4.3's scope-tree host link |
| invocation stamps          | invocations whose host is in scope — what `restore(t)` sweeps         |
| host records               | the predicted player's own record, plus records of scoped entities    |
| id allocator               | whole; it is small, and a partial freelist would hand out reused ids  |
| **seeded PRNG** (`Random`) | **whole** — global, not entity-keyed                                  |
| breaker counters (§4.4)    | counters for handlers on scoped hosts                                 |
| `Broadphase`               | derived — rebuilt from transforms on `apply`                          |
| `RegionIndex`              | derived — build-time and immutable (§8.2)                             |
| KV layer                   | not captured — `ServerScript`-only (§5.4), never in a predicted path  |

**The PRNG is the easiest entry to miss and breaks determinism outright.** Its stream is stateful — every
`between`/`pick`/`chance` advances it — so a replay resuming from the wrong position draws different
numbers, precisely the failure seeded randomness exists to prevent (§1.2). A per-entity split is not
well-defined: draws from different entities interleave into one sequence, so no subsequence belongs to a
scope.

That omission would have been in the table rather than the mechanism, so registry coverage alone would not
have caught it — the PRNG would have registered and then scoped wrongly. **The coverage test therefore
also asserts every registered store declares a scoping mode**, with no default to fall into.

#### `restore()` cannot roll back a parked async handler

A `SyncedScript` handler suspended at an `await` is a closure in the JS heap that `snapshot`/`restore` has
no handle on, so after a rewind it survives from a timeline that did not happen — holding its `ignore`
lock forever (§4.2), keeping its scope-tree entry, and eventually resuming to run its second half against
a present it never saw.

So **every invocation is stamped with the tick it started on, and `restore(t)` sweeps every invocation
newer than `t`**: mark it dead, release its concurrency lock and scope-tree entry, and drop its timer so
the promise never settles, leaving the continuation unreachable and collected unrun. This reuses §4.3's
scope tree; the tick stamp is the one new field, available because `step` takes its index as an argument.

**Synchronous handlers are unaffected** — the entire block tier and most text-tier gameplay. So **the
bit-exact round-trip claim scopes to synchronous handlers**: an awaiting handler is cancelled by a rewind
rather than replayed through it, so authoritative state written after an `await` in synced code is dropped
on a correction. The alternative is resuming a continuation from a rolled-back timeline, and §1.2 already
prefers `ServerScript` for anything long-running.

Two properties the implementation owes, both testable without a network:

- **A snapshot is a value, not a view.** It aliases nothing live, or a later tick mutates what a replay
  was going to restore from.
- **`restore(snapshot(t))` then `step` over the same inputs reproduces the same state, bit for bit**, for
  synchronous handlers. That round trip _is_ the determinism test (§11) and makes a desync reproducible in
  Node rather than only in a playtest.

The tick counter is a monotonic integer from 0, engine-internal — creators never see frame counts, only
seconds (§1). It is what input indexes against and what `sendRate` divides.

#### A historical query is a third caller of `capture`, and it is not a rewind

The client rewinds; the harness replays; the third caller reads. **The server needs to read past state
without changing the present.** Any authoritative resolution of an action whose input was formed against a
stale view of the world needs it — the general case, of which lag-compensated hit tests are one instance:
a client fires at what it saw up to a send interval ago (the stale-collision cost above), and the server
must judge the shot against the world as it stood then, not as it stands now.

**Reads happen in the past; writes always happen in the present.** That is the whole invariant, and every
consequence below falls out of it. Nothing may write into a capture — the ring is read-only from the
moment `capture` returns until the buffer's slot is reused — and no query mechanism may reach `restore`,
whose sweep would corrupt the live invocations that asked. If a future feature needs to mutate history,
it is not this mechanism.

**`restore(past)` → query → `restore(present)` is the wrong mechanism** for exactly this reason. `restore`
sweeps every invocation newer than the target tick, so on the server it would cancel live `ServerScript`
continuations — the query would corrupt the authoritative code that asked for it. A historical query
reads a captured buffer and leaves the simulation running.

**Creator surface: one flag on the spatial queries that resolve against other entities.** `find({ near })`,
`getTouching`, and any future raycast take an optional `asSeen` — present-tense is the default:

```ts
game.find({ near: ctx.aim, within: 5, asSeen: true });
```

The flag pulls the view tick from the dispatch context — an `@onRequest` for a shot carries the tick the
firing client saw — clamps to an engine constant `maxRewindMs` (~250ms), and validates the client's
reported tick against the server's own latency estimate for that connection. So no tick arithmetic reaches
creator code, and the block tier likely renders this as a panel toggle on the hat rather than a visible
flag on the query — the name is a placeholder. Off the flag, the query runs against the live world, which
is what every non-shot case wants.

**Wire-time rejections (§3.4).** `asSeen` in a `SyncedScript` — the ring is server-only, and reading from
it in synced code would desync (§1.2). `asSeen` outside an input-originated handler — there is no view
tick to key the read against, and defaulting to "now" would silently produce a present-tense answer under
a name that promised otherwise. Both are load-time errors pointing at the input handler that carries a
usable tick.

Three interface consequences, all cheap to honour now and expensive to retrofit:

- **The server retains a ring of transform captures sized by `maxRewindMs`.** ~250ms at `sendRate` is
  roughly five buffers, so a query reaches back as far as a client's staleness can plausibly go. One
  buffer; each query indexes into it at its own offset — the ring is written by the loop, read by every
  concurrent query. `capture(into)` already gives the buffer reuse this needs (the same out-param that
  spares the client's per-frame allocation), so the ring is a fixed set of buffers refilled in turn, not a
  per-tick allocation.
- **`Broadphase` must be constructible over a supplied transform buffer.** §8.1 declares it derived and
  rebuilt from the live transforms on `apply` — destructive, and useless for a query that must not disturb
  the present. A throwaway index built over one ring buffer answers "what overlapped back then" without
  touching the live index. This is one constructor argument now (the transform source) and a rewrite later.
- **A store declares whether it participates in historical queries**, alongside its scoping mode (§8.1) —
  the transform store yes, the KV layer no. Same registry, same coverage test: a new store either answers
  the question or the test fails, so a query silently reading a store that never meant to be read backward
  is made impossible rather than remembered.

**This does not weaken the round-trip claim.** A query reads a buffer and discards its throwaway index; it
runs no `step`, sweeps no invocation, and marks no channel — so it is invisible to the determinism test
(§11) and to replication. It is `capture` used for reading, with none of `restore`'s live-world effects.

#### `@onUpdate` dispatches from both entry points, filtered by location

One decorator carries two rates (api_spec.ts:898, api_design.md §12.2), so the split is stated rather
than left to fall out of two call sites:

| Path    | Dispatches `@onUpdate` on              | Rate         | `ctx.dt`              |
| ------- | -------------------------------------- | ------------ | --------------------- |
| `step`  | `SyncedScript` and `ServerScript` only | `simRate`    | exactly `1 / simRate` |
| `frame` | `ClientScript` only                    | display rate | measured frame time   |

The sets are disjoint, so no handler runs twice per frame and none is missed. `frame` does **no**
simulation — no movement tick, no contacts, no timers — which keeps a 144Hz client from advancing the
world faster than a 60Hz one.

**A `ClientScript` may not write the transform store.** §1.2 forbids it as a trust rule; the rewind makes
it a correctness rule too, since a client-written transform would be clobbered by the next `restore` or
snapshot apply — the write appearing to work and then silently vanishing. Camera remains the documented
exception: presentation, not in the transform store, not captured. A client script moving something
visually has `playEffect` and its own fields; moving something actually, it has `request`.

### 8.2 Tick order is spec

Leaving this to the implementation would make it a desync source (§4.1), so the order is fixed and tested:

```
1  adopt tick         current = the `tick` argument; NOT an increment
2  input apply        tick-indexed input -> ActionState edges, intent filled
3  input dispatch     @onEvent press / release / hold
4  movement tick      accelerate -> applyForces -> clampSpeed -> move   (per avatar)
5  contacts           resolve the set; dispatch @onCollide / @onEnter / @onExit
6  regions            point-in-region enter/exit; dispatch @onEnter / @onExit; checkpoints
7  timers & tweens    sleep / every / after, motion verbs, Countdown
8  @onUpdate          simRate handlers
9  destroy drain      teardown deferred in §6
10 replicate          every simRate/sendRate ticks — marks the three channels of §5.1
```

Three orderings carry an argument:

- **Input before movement** (3 before 4), so a jump bound this tick is in `velocity` before `move()`
  integrates. Otherwise every jump is one tick late.
- **Movement before `@onUpdate`** (4 before 8), required outright by api_spec.ts:694: a handler reading
  `velocity` or `blocked` sees this tick's resolved values.
- **Regions after movement** (6 after 4), so a body entering a zone this tick fires this tick.

**Step 1 adopts rather than increments.** A counter here would be a second source of truth that a replay
desynchronizes — re-running tick 97 would report 98. Everything reading "the current tick" reads what was
adopted: the input index, the error log's tick field (§4.4), the invocation stamp `restore` sweeps against
(§8.1).

**Step 6 is a separate pass from step 5.** Both dispatch `@onEnter`/`@onExit` (api_spec.ts:915), but they
are different tests over different data: step 5 asks which colliders overlap; step 6 asks which bodies are
inside which panel-authored region — a point-in-shape test against static authored geometry, with no
collider involved and no requirement that the entity have one. Region membership is also what
`find({ in })` resolves against and where §7's checkpoint update happens, so without its own step the
checkpoint behaviour has nowhere to fire.

**Regions use a build-time index, not the `Broadphase`.** Regions are panel-authored and fixed for the
session — `bounds` is build-time (§7) and no runtime API creates one — so the index is built once at load
and never updated, and each tick is a point query per entity against static shapes. Routing this through
the per-tick AABB pass would rebuild an index over immovable geometry sixty times a second. The two
structures look interchangeable from outside, so the choice is named here.

### 8.3 Loading and wiring

`loadGame(manifest)` is the entry point, and the order is the observable contract (§3.6):

```
1  build the world      templates, regions, bounds, authored static entities
2  restore              @serverState from the game record
3  attach Game scripts  wire + hoist; no @onStart yet
4  start the loop       tick counter begins; ticks available to anything that awaits
5  run Game @onStart    each handler to its FIRST AWAIT, then continue
6  release joins        each join: Player record, avatar from the Player template,
                        camera, Player-hosted scripts, then their @onStart
```

**Awaiting `@onStart` to completion deadlocks, which is why step 4 precedes step 5.** `await sleep(1)`
inside a Game-hosted `@onStart` needs ticks to elapse; the loop supplies them; under await-to-completion
the loop has not started because it is waiting on `@onStart`. Starting the loop first and proceeding at
the first `await` is §5.8's existing dispatch rule applied to a lifecycle handler, not a second mechanism.

**Consequence, documented in api_design.md §3.6:** a player's `@onStart` may run before the Game's has
finished. World construction belongs _before_ the first `await` in a Game-hosted `@onStart`; only
sequencing belongs after it. A handler with no `await` — the common case, and the only one the block tier
can express — finishes before any join.

There is no registration call and no export scanning: the manifest is the panel's tray, made data (§8.1).

### 8.4 The ambient consts

`game`, `hud`, `random` and `assets` are module consts in the spec (api_spec.ts:89, 141, 442, 521), but
the `Game` is built by `loadGame`. Each const is therefore a **facade over a swappable runtime slot**: the
creator-facing name never changes identity, while `createRuntime()` / `withRuntime(rt, fn)` give tests and
a multi-game host an isolated world. Without this the spec's module-const surface would be untestable and
single-instance-per-process.

---

## 9. Two changes in `@platform/math`

Both are prerequisites, and both are independent of §1–§8.

### 9.1 Deterministic replacements for `Math`

api_design.md §11.2 is the contract. **ECMA-262 leaves the transcendental functions
implementation-approximated**, so two V8 versions may differ in the last bits, and a `SyncedScript`
diverging by one ULP on a bullet angle rubber-bands within a second. `Math.random` is the separate,
easier failure: unseeded rather than approximated, already replaced by the seeded stream.

**22 functions:** `sin` `cos` `tan` `asin` `acos` `atan` `atan2` · `sinh` `cosh` `tanh` `asinh` `acosh`
`atanh` · `exp` `expm1` `log` `log1p` `log2` `log10` · `pow` `cbrt` `hypot`.

Realistically **six implemented carefully and the rest derived**: `sin`, `cos`, `atan2`, `pow`, `exp` and
`log` are what games ask for; `tan`, `log2`, `log10` and the hyperbolics follow by identity, and an unused
entry may be absent until something needs it. Each is a polynomial/range-reduction implementation over
exact IEEE-754 operations, so results are bit-identical everywhere — the goal is reproducibility, not
accuracy beyond the built-in's.

**What stays safe**, keeping the ban narrow: the arithmetic operators, `abs`, `sign`, `min`, `max`,
`floor`, `ceil`, `round`, `trunc`, `fround` and `sqrt` are exact IEEE-754 operations and agree
bit-for-bit. The samples' `Math.max` / `Math.min` / `Math.floor` / `Math.ceil` need no change.

- **`hypot` is `sqrt(x*x + y*y)`** — deterministic and faster. The built-in scales inputs to avoid
  intermediate overflow and this does not; at world-pixel magnitudes the squares are far from the exponent
  limits, so the trade is free here and would not be in SI units.
- **`**` is `Math.pow`.** Banning the method while `x ** 2` compiles catches nothing, and the operator is
  the spelling a creator reaches for. Verified: this repo's oxlint `no-restricted-properties` catches
  `Math.*` but **not** the operator (`2 ** 3` passes a config rejecting `Math.pow`), so the operator needs
  its own rule or an AST check alongside §3.4's pass.

### 9.2 `Vec3` becomes readonly

api_spec.ts makes `Vec3` readonly component-wise (§3.1) while math ships it mutable and the renderer
writes through it on a hot path. Math matches the spec:

- `Vec3` — readonly `x` / `y` / `z`. The creator-facing type, re-exported by `@platform/engine`.
- `MutableVec3` — new. What `vec3()` returns and what `vec3Set` / `vec3Copy` take as `out`.
- `Vec3Like` — unchanged, the parameter form with optional `z`.

`MutableVec3` is assignable to `Vec3`, so signatures that _return_ a vector need no change; only positions
**written to** move. Blast radius: ~22 helper call sites across `renderer/src/projection.ts` and
`renderer/src/core/renderer-core.ts`, plus `Transform` in `renderer/src/renderer.ts`. Mechanical, and the
renderer's contract suite covers it.

**Caveat:** TypeScript ignores `readonly` in assignability, so passing a `Vec3` into a `MutableVec3`
parameter still compiles. The guarantee catches `entity.position.x = 5` — the assignment a creator
actually reaches for — and is not a deep immutability claim.

---

## 10. Seams

Each is an interface with a null implementation in core, so every tier A member is exercised in Node with
no browser and no network.

| Seam              | Null implementation                           | Real owner            |
| ----------------- | --------------------------------------------- | --------------------- |
| `Clock`           | manual, test-driven                           | host app              |
| `PhysicsSink`     | integrate position, `blocked` all false       | Rapier                |
| `Broadphase`      | naive O(n²) AABB (§2) — three consumers       | Rapier or a grid      |
| `ContactSource`   | over `Broadphase`, filtered by `isTrigger`    | Rapier                |
| `RegionIndex`     | built once at load; point queries (§8.2)      | core — panel-authored |
| `KVStore`         | in-memory `Map`                               | `@platform/platform`  |
| `InputSource`     | scripted tick-indexed frames                  | `@platform/client`    |
| `SceneSink`       | none — drains the transform bitset (§5.1)     | `@platform/renderer`  |
| `ReplicationSink` | none — drains all three channels (§5.1)       | `@platform/server`    |
| `AudioSink`       | no-op; drops calls under `replay` (§8.1)      | audio layer           |
| `EffectSink`      | no-op; drops calls under `replay` (§8.1)      | `@platform/client`    |
| `InterpBuffer`    | none — display source for the unpredicted set | `@platform/client`    |

---

## 11. Layout, config, testing, build order

**Layout.** `src/{script,dispatch,loop,world,player,state,data,motion,hud,assets,audio,net,runtime}/`
plus `index.ts`, `ids.ts`, `config.ts`, `errors.ts`, `random.ts`. Grouped by concern; the two directories
that matter are `script/`, where every decorator and the metadata polyfill are contained to
`decorators.ts` (§3.3), and `world/`, which holds the tier A trio.

**Config.**

1. `lib` gains `esnext.decorators` wherever decorators are declared or consumed (`packages/core`,
   `packages/engine`, `examples`), for `Symbol.metadata`'s type. No `experimentalDecorators` anywhere;
   §3.3's tsconfig half is the polyfill, not a flag.
2. `examples/tsconfig*.json` `include` gains `games/**`, and `examples/package.json` gains the
   `@platform/engine` project reference it already declares as a dependency. **The sample games are
   typechecked by nothing today** — `include` is `src/**` only — which is how 53 decorator errors sat
   unnoticed; this is what makes the acceptance gate below a real gate.
3. `@platform/math` gains the deterministic `Math` replacements (§9.1) and `MutableVec3` (§9.2); the
   renderer's out-param sites follow.
4. `.oxlintrc.json` gains `no-restricted-properties` for the 22 approximated `Math` members plus
   `Math.random`, each message naming its `@platform/math` replacement (§9.1). The `**` operator needs a
   separate rule.
5. `NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where type-only,
   no import cycles — `.oxlintrc.json` enforces the last two.

**Testing.** Five shapes, mirroring how the renderer was validated:

- **Pure modules, no world** — transform store, tag index, `find`, scope tree, easing, the fixed-step
  accumulator, the registry's metadata walk. The deterministic `Math` replacements (§9.1) belong here as
  fixed input/output vectors, so a regression is caught as arithmetic rather than as a desync.
- **A deterministic loop harness** — a scripted `Clock` and `InputSource` over `step`, so a test asserts
  "after 120 ticks the avatar is here" with no clock. Two runs of one input sequence must produce
  byte-identical state, and `restore(snapshot(t))` + replay must reproduce it (§8.1); those two assertions
  _are_ the determinism claim.
- **The sample games as the acceptance gate** — the ~13 files under `examples/games/` typecheck against
  the real engine. Any spec gap they surface gets reported, not silently patched.
- **Type-level tests** for the `@serverState` constraint (§5.2), the one guarantee no runtime test reaches:
  a fixture asserting mutable declarations fail to compile and readonly ones do not, as a checked-in
  `tsc --noEmit` expectation so the predicate cannot silently loosen.
- **A registry-coverage test** (§8.1): every store the runtime holds must be registered, **must declare a
  scoping mode**, and **must declare whether it answers historical queries** (§8.1), so adding one without
  registering it — or registering it without deciding how it scopes, which is how the PRNG was nearly
  missed — fails here rather than as a playtest desync.

Named tests for the highest-risk behaviours: a `@serverState` field leaves **no data property** and every
write form marks the state channel (§5.2); a stale persisted tag is dropped rather than restored (§5.2); a
wrapper bound twice throws (§5.2); the three channels stay separate (§5.1) and survive a `restore`
unrestored (§8.1); tick order including the region pass (§8.2); a tick index is adopted rather than
incremented, so replaying tick 97 reports 97 (§8.2); snapshot/restore round-trip and the scoped form
(§8.1); `restore` sweeping a parked invocation releases its concurrency lock (§8.1); a breaker counter
rewinds with the snapshot, so a replay re-enables a handler disabled after `t` (§4.4); a Game `@onStart`
that `await`s a `sleep` does not deadlock and releases joins at its first await (§8.3);
destroy-during-dispatch (§6); cancellation across an await (§4.3); and a throwing handler leaves the tick
running while a throwing wire aborts (§4.4).

Three more for the replay path, each guarding a bug that appears only under packet loss: a replayed tick
plays no sound and fires no effect while producing identical state; `step` with a scope advances only that
scope, leaving an unscoped entity's transform untouched across a rewind-and-replay; and a replay draws the
same PRNG values as the original run.

One more for the historical-query path (§8.1): a query against a past capture returns that tick's overlaps
while leaving the live world untouched — no invocation swept, no channel marked, the present tick's state
bit-identical before and after — the property the rejected `restore(past)→restore(present)` mechanism
would violate. Paired with two load-time tests, one per rejection: `asSeen` on a spatial query in a
`SyncedScript` fails to compile, and `asSeen` from a handler carrying no view tick fails to load.

**Build order.** Each step is testable before the next exists:

1. `ids.ts`, `errors.ts`, `config.ts`, **the store registry** (§8.1), the transform store, the tag index —
   pure, no world. The registry comes first so every later store registers as it is written.
2. the decorator registry, bases and the location grid — the `Symbol.metadata` polyfill and the metadata
   copy-on-write walk (§3.2) land here and nowhere else.
3. the scope tree, invocation records, the dispatcher, the error boundary and its breaker counter (§4.4) —
   cancellation and failure handling before anything awaits.
4. `Entity` (transform, hierarchy, tags, destroy) — the first tier A member.
5. `step` + the tick order + `opts.replay` and `opts.scope`, then `advance` over it, then timers and tweens
   with the `Clock` seam (§8.1, §8.2); `snapshot`/`restore` over the registry, plus the parked-invocation
   sweep. **The two `opts` land here, before any effect call site exists.**
6. `Game`, templates, the `Broadphase` (§2) — constructible over a supplied transform buffer, not only the
   live store, so the historical query (§8.1) is a constructor argument now rather than a rewrite — the
   ring of transform captures sized by `maxRewindMs`, the `RegionIndex` + the region pass, `find`.
7. `Player`, the roster, the `@serverState` accessor pair, the immutability predicate, host records and the
   three channels (§5.1, §5.2).
8. `Storage` + `KVStore` + persistence, then `loadGame` — steps 6–8 make §8.3 expressible.
9. the wrapper base with `bind` / `serialize` / `restore` (§5.2), then the four wrappers on it, then the
   tier C shells, then the `@platform/engine` barrel.
10. math: the deterministic `Math` set (§9.1) and `MutableVec3` (§9.2), plus the renderer's call sites and
    the lint rules — independent of 1–9, so it can run in parallel.

---

## 12. Open questions

Thirteen items: four findings, two deferred TODOs, seven spec gaps. **Decorator flavour is not among
them** — the spec declares standard decorators (api_spec.ts:847) and legacy cannot implement
`@serverState` at all (§3.3), so it is settled on correctness grounds rather than deferred.

**Findings — already wrong in the tree or the prose:**

1. **The `@onStart` await rule changed api_design.md §3.6 and §5.1** (§8.3): "awaited before any join is
   released" became "joins release at its first `await`", because the former deadlocks on `await sleep()`.
   Both prose sites are updated. The consequence — a player's `@onStart` may run before the Game's
   finishes — is documented rather than engineered around, and is worth a second look by anyone reading
   §3.6 fresh.
2. **A sample game holds the bug §5.2 forbids.** `battle-royale/player.ts:28` declares
   `@serverState ammo: Record<WeaponKey, number>` and `fighter.ts:51` writes `me.ammo[key] -= 1` — a
   nested mutation changing the host record without marking the state channel, so no client sees the ammo
   count move. It went unnoticed because the samples are typechecked by nothing today (config note 2).
   Recommendation: `Inventory` is a per-player keyed count, which is what an ammo map is — so the fix is
   the wrapper, not a `readonly` record. Not patched here, since it changes a sample's design rather than
   the engine's.
3. **`restore()` is bit-exact only for synchronous handlers** (§8.1). A handler parked at an `await` is a
   heap closure no snapshot can capture, so a rewind cancels it rather than replaying it, and a
   `@serverState` write after that `await` in synced code is dropped on a correction. The block tier is
   entirely synchronous and unaffected. Worth revisiting only if creators start putting authoritative
   writes behind awaits in `SyncedScript`s, which §1.2 already steers away from.
4. **api_design.md:207 reads as though interpolation writes the value collision reads** (§8.1). It says
   `position` is "written by `move()` every tick, interpolated between replication frames, and read by
   `distanceTo`/`moveToward`/`near`/collider bounds" — three true clauses about different things that
   together describe the arrangement §8.1 rejects. Recommendation: reword when §8.1 is implemented, since
   it is the sentence somebody would otherwise implement literally.

**Deferred TODOs — specified here, waiting on work outside core:**

5. **The loop watchdog is incomplete until §3.4's AST pass exists** (§4.3). Counting loop back-edges needs
   instrumentation over creator source, so a synchronous infinite loop currently hangs the tick instead of
   aborting it. The wall-clock alternative is rejected outright — it diverges by hardware and would make
   the watchdog a desync source — so this waits for the pass rather than shipping a time budget.
6. **Source-level determinism and trust checks** (§3.4), and the `**` operator ban with them (§9.1). Needs
   a TS AST pass beside the panel's type emission. Runtime throws carry the eventual load-error text
   meanwhile.

**Spec gaps, with recommendations:**

7. **Entity-instance persistence** (§5.3). A runtime-spawned entity has no cross-session identity.
   Recommendation: persist panel-placed entities by authored id; session-only for spawned ones, with a
   load-time warning.
8. **A renamed `@serverState` field loses its stored value** (§5.2). The type tag makes the loss safe and
   loud rather than silent, but there is no migration story in MVP. Recommendation: leave it until a
   shipped game needs a rename, then consider a panel-authored rename map rather than anything in the
   runtime.
9. **Checkpoint storage** (§7, api_spec.ts:368). Recommendation: engine-internal on `Player`, set by
   `spawn()` and by a panel-marked checkpoint region, defaulting to the template spawn point — updated in
   §8.2's region pass, where membership is already computed.
10. **The stateful wrappers need a shared exported base carrying a contract** (§5.2). `Scoreboard`,
    `Leaderboard`, `Inventory` and `Team` are declared independently (api_spec.ts:972–1004), so "is this
    field implicitly authoritative" has no `instanceof` to ask and a creator subclass has nothing to
    inherit the channel-marking from. `instanceof` alone is not enough: a wrapper is constructed as a field
    initializer, before any host, record or field name exists, leaving four things undefined — what it
    marks, how it persists, what its type tag is, and what happens if one instance is assigned to two
    hosts. Recommendation: the base declares `bind(record, fieldName)` (called by wiring, throws if already
    bound) plus `serialize` / `restore`, closing all four through one interface. `Countdown` and `Storage`
    stay outside it (§5.2). This is the largest spec addition here and the one core cannot work around.
11. **`Countdown` "fires `@onEnd` on reaching zero"** (api_spec.ts:962). `@onEnd` is a _host_ lifecycle
    decorator, so whose `@onEnd` a wrapper fires is undefined — a `Countdown` is not a host.
    Recommendation: give it its own callback (`new Countdown(s, onZero)` or an `@onEvent` name) rather than
    overloading a lifecycle decorator, and correct the spec line.
12. **`Bounds` in world or entity space** (api_spec.ts:45) and **`Collider.bounds`** with it. The renderer
    settled its own orientation question (renderer DESIGN §18); core needs the same answer for
    `collider.bounds` before the `Broadphase` is more than a placeholder. Recommendation: world-space AABB,
    recomputed per tick, matching `worldBoundsOf`.
13. **`find({ near })` distance metric** (api_spec.ts:478). Recommendation: Euclidean over x/y, ignoring z
    while z is reserved — and say so in the doc comment, since a creator reading "within 200" will assume
    it.

# `@platform/server` — internals

**TL;DR.** The authority process. It holds the one core `Runtime`, advances real time into ticks off an
**injected** clock, admits and buffers untrusted client input per intended tick, and drains core's three
replication channels onto the wire every send-tick. It sits between `@platform/transport` (opaque frames)
and `@platform/core` (simulation, no clock, no network) — the seam where core's `ReplicationSink`
obligation is met and a `Transport` per player is held. `@platform/client` is its wire peer; they share
only `@platform/protocol`, which is authoritative for every envelope shape. The server is **policy**:
which tick an input applies to, whether it is admissible, when to broadcast, what each connection is
owed. It never opens a socket, never reads `Date.now()`, and never re-implements the tick order.

It is driven by an injected clock over a `loopbackPair`; a socket listener belongs to the composition root,
which `accept` is shaped for.

| File            | Holds                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `server.ts`     | `GameServer`: registry, `accept`, join/reject/resync, `pump`, `setSimRate`, close path; the inbound-frame narrowing |
| `connection.ts` | `Connection` record; `AdmissionState` (resolution frontier, headroom, token bucket)                                 |
| `input.ts`      | `InputBuffer` (tick-keyed, `drainThrough`), the admission checks, `runInputPass`                                    |
| `driver.ts`     | `Driver`: accumulator, step cap + shed, send cadence, `deliver`→step, self-driven `start`                           |
| `broadcast.ts`  | the three drains → `SendSet`, wire retyping, `encodeHostField` / `encodeStateValue`, the fan-out                    |
| `snapshot.ts`   | `buildSnapshot` — the join-time world walk; `ancestorsFirst`                                                        |
| `chunk.ts`      | `splitSnapshot` — dividing a join snapshot one frame cannot carry                                                   |
| `manifest.ts`   | `ManifestStore` — the live render manifest, its join payload and its pending additions                              |
| `constants.ts`  | engine constants, in ms with per-`simRate` tick conversions                                                         |
| `errors.ts`     | `ServerError` and its `ServerErrorCode` union — every condition this package throws on                              |

---

## 1. Scope

**Owns.** Connection acceptance and the registry; player allocation at join and the join reply;
construction of the authoritative world via `loadGame`; the real-time→tick accumulator, its step cap and
shed policy; the tick-indexed input buffer and its jitter scheduling; admission (identity, window, rate,
plus join deadline and unjoined cap); `hold` synthesis and movement `intent`; the call into `Loop.step`;
the post-step drain of core's three channels into tick-stamped envelopes.

**Does not own.** Encoding (an injected `Codec`) or envelope shapes (`@platform/protocol`); the
simulation (core); a frame's reliability class or byte movement (transport); prediction and interpolation
(client). Depends on `core`, `project`, `protocol`, `transport`, `math`. Never imports `client` or `renderer`.

---

## 2. The core surface it drives

Core exports no `createWorld` / `step(tick, inputs)` / `collectChanges`; this is the real mapping.

| Need                | Core's surface                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| build the world     | `loadGame({ role: 'server', … }, { scriptIdOf })` → `Runtime`, then `startGame(rt)`              |
| location filter     | `role: 'server'` → `activeLocationsFor('server')` = `['server','synced']`                        |
| step one tick       | `new Loop(rt).step(rt.tick + 1)` — **takes no inputs**                                           |
| apply input         | `rt.passes.input(dispatch)`, whose stub the server replaces (§4.2)                               |
| "collect changes"   | three drains: `channels.drainStructural()`, `channels.drainState()`, `transforms.consumeDirty()` |
| roster              | `joinPlayer(rt, id, name)` / `leavePlayer(rt, id)`, `rt.playerManager.players`                   |
| reads for snapshots | `entities.liveIds()`/`record`/`idAt`, `tags.tagsOf`, `transforms.*`, `hosts.get`                 |
| services            | left at core's null seams, except `kv` / `persisted`, which this package fills (§7)              |

---

## 3. Connection and join

### 3.1 A registry over a `Transport` factory

`Transport` is one end of one established connection, so the multiplexer transport declined to hold lives
here: `Map<connectionId, Connection>`. Keyed by a **server-minted `connectionId`, never by player id**,
since a connection exists before it has a player and may end without ever getting one.
`accept(transport, playerId?)` returns the id, or **`null`** for a socket it refused and closed — an id for a dead socket reads at the composition root as a
live connection. The composition root feeds it from `loopbackPair()` or from a socket listener, and the
optional `playerId` is the **host's** claim about who the peer is, never the peer's: it becomes `player.id`,
so it is what persisted `@serverState` is keyed by and what every other peer sees on the wire.

`Connection` carries `transport`, nullable `player`, `identity` (the host's id for this peer, or null),
`playerId` (that identity or the `connectionId`), `pendingJoin`, `admitting` (true while the persisted read
is in flight), one `ActionStates` fold (core's, not a second implementation), `AdmissionState`, `disposers`,
`acceptedAtSeconds` (null until the first wake observes it — the injected clock's epoch is unknown), and
`closed`.

### 3.2 The client speaks first

`accept` mints the id, registers `onMessage`/`onClose` **before** any state mutation, enforces
`MAX_UNJOINED_CONNECTIONS`, and sends nothing. The first valid `JoinRequest` then: checks
`protocolVersion`, checks **identity**, loads this player's persisted record into the cache when the host
named one — which answers an identified join a turn later than an anonymous one — checks `maxPlayers` and
that no live connection already holds that id, calls `joinPlayer` (which fires `@onPlayerJoin`, whose handler
spawns or spectates), sanitizes the name (NFC, Unicode control **and format** characters stripped, ≤24
**code points**, blank → `player`), stores `pendingJoin`, and queues a `player-join` roster op. The
`Welcome` itself is built at the next send-tick (§5.1). `index` is assigned by core's `PlayerManager`,
never by the server.

**Identity is checked above capacity**, because a client running other code is refused whether or not there
is room and `full` would send it back to retry a refusal that is not about room. `ProjectIdentity` is
compared, never computed — whoever built the project knows what went into it, and a server deriving its own
hashes would be checking itself. `projectId` and `projectHash` must agree exactly; a `bundleHash` of `''`
means the joiner holds no bundle yet and will fetch the one `Welcome` names, so it is the one legal
asymmetry, while a non-empty mismatch is a client running stale code and rejects as `identity`. An omitted
`config.project` declares every field empty, which is what a client declaring none sends — so agreement, not
absence, is what passes, and a one-sided declaration is a mismatch. The resync path re-checks, since a client
may have loaded a bundle since it joined.

A refusal is `Reject { reason, serverProtocolVersion }` **then** `close()` — a bare close is
indistinguishable from a drop, and `version` and `identity` must never be retried while `full` is not a
network error at all. `maxPlayers` is deliberately absent from `Welcome`. Inbound frames are narrowed
structurally in `server.ts`, not cast (`join-request`, `input`, `interaction`, `time-sync` only), against
**every** field the type declares rather than a `Partial` of it — so a frame missing the identity fields is
malformed like any other,
ignored, and closed by the join deadline; the `version` reject can only refuse a peer whose frames still
parse. A **resync** re-sends `JoinRequest` on a joined connection: it re-arms `pendingJoin` and
allocates no second `Player`, and it spends a control token (§4.3) — a resync is the most expensive thing
a single frame can ask for.

### 3.3 The join snapshot is a walk of the live world

A joiner holds nothing, so it needs a complete picture; core's channels are deltas and `Loop.snapshot()`
is the private rewind form. `buildSnapshot(rt, forPlayer)` therefore reads live structures: `tick`,
entities in `ancestorsFirst` order, the roster, and `@serverState` from **three** sources — all
game-record fields, this player's own player-record fields (player-hosted state is scoped to its owner),
and every live entity's entity-record fields — read through the same `encodeHostField` the per-tick diff
uses, so a joiner's baseline and the deltas that follow it cannot disagree about what a wrapper is or
about which fields are unrepresentable.

`ancestorsFirst` is a real topological emit, not core's slot order: parenting is a post-hoc mutation, so
`spawn(child); spawn(parent); child.attachTo(parent)` leaves the child in the lower slot, and the wire
requires parents first. It is iterative and `seen`-guarded, roots a child whose parent is not live, and
still ships anything a cycle stranded.

**There is no per-tick mirror.** One would pay O(players × dirty) writes per tick to serve a read that
happens once per join, and delta replication needs per-connection _acked baselines_ — a
single current-tick view is the one version no connection is behind at.

### 3.4 Constructing the world

One runtime, once, in the constructor, in this order: the **driver** first, because it is the one thing
that checks `simRate` and `sendRate` and a bad rate must refuse before a world is built rather than after —
there is no second rate assertion here; then `loadGame({ role: 'server', simRate, bounds, regions?,
assets?, templates?, entities?, gameScripts? }, { scriptIdOf? })`, which builds the template registry,
wires the Game scripts and instantiates the placed scene against that registry — a world built against an
empty registry is a world of bare entities. Then the input pass is installed **before** the first step,
then `startGame(rt)` is called and **not awaited** — its promise settles when every `@onStart` completes,
and a handler awaiting a timer cannot complete until the loop steps, so awaiting it deadlocks the server
against its own driver. The synchronous run to each first `await` is the guarantee that matters; `server.started`
exposes the promise for a host that wants it. `ServerConfig` extends `Partial<EngineConfig>` and adds
`bounds`, `regions`, `visuals` (`RenderManifest` → `Welcome.visuals`; core's asset registry holds no
`url`), `project` (`ProjectIdentity` → the handshake comparison and `Welcome`'s four identity fields),
`templates` / `entities` (`toGameManifest`'s output, forwarded to `loadGame`), `scripts` (a `ScriptIndex` —
one method, `idOf`, declared structurally because `@platform/scripting`'s registry imports core) and
`gameScripts`. Defaults: `simRate` 60, `sendRate` 20, `maxPlayers` 8, bounds ±400 × ±300 —
and `maxPlayers` is **validated** here, because `resolveConfig` fills defaults without checking and a head
count below one admits nobody. A missing `rt.passes` throws for a related reason: silently keeping core's
stub leaves every input unapplied, which reads as a dead game rather than a wiring fault.

`booted` is false until every step above has run, and `accept` refuses while it is: a joiner's snapshot is
its entire baseline, and no later delta repairs one taken of a world still being assembled.

`GameServerOptions.onBreakerTrip` is the dev channel: core hands it every handler or callback the breaker
disabled, and it is registered before `startGame` so a Game `@onStart` that trips on its first tick is still
reported. Not an envelope — a disabled handler is something whoever runs the server has to see, while a
player's client can neither act on it nor be trusted with a stack, and a wire arm would put it under
protocol's receiver-bounds rules for no benefit.

`GameServerOptions.log` is the operator channel, handed straight to `loadGame` as core's `LoadOptions.log`
rather than reimplemented, so this package's own decisions and core's diagnostics leave through one sink.
Every denial writes one line — the three `Reject` reasons, the rate-breach close, the join-deadline sweep,
a `send-failed` close, and `accept-refused` with the reason it was refused — as `event conn=<id>
reason=<token>` with any prose after a colon, because these are read by grep and a stable token is the
whole point. `accept-refused` carries no id: one is minted for a socket this server keeps, and an id in a
line for a socket it just closed is an id a reader would go looking for.

---

## 4. Input and admission

This is the untrusted, adversarial boundary; every check here exists because a frame cannot be trusted.

### 4.1 The buffer is keyed by tick

`InputBuffer` files each admitted frame under the tick it will be applied on, so timing is judged on the
tick the player pressed rather than on their ping. The drain is **`drainThrough(tick)`** — every slot at or
before the stepped tick, oldest tick first — because the past grace and a shed (§6.2) both produce slots
the loop has already walked past. Late beats never: edges are not idempotent, and oldest-first preserves
press-before-release. `dropConnection` clears a closed peer's pending frames.

### 4.2 The input pass

Installed over core's stub, it runs at tick order step 3–4, after the starts pass: `advanceTick()` once
per connection (so
one-tick-wide `pressed`/`released` clear even on a quiet tick), then the drained frames are folded through
core's `applyEdge` and dispatched, then per connection the stale-hold backstop, the synthesized `hold`, and
`movement.fillIntent(moveX, moveY)`.

- **`hold` is synthesized, not received.** The client sends edges only, but `@onEvent(…, { on: 'hold' })`
  fires every tick while held — so a wire `hold` sample updates the axis and dispatches nothing of its own,
  and the pass dispatches `hold` for held buttons **union** non-neutral axes (an axis never enters `held`).
- **`fillIntent` runs here**, ahead of movement's step 4; without it `intent` stays zero and nothing moves.
- **Identity comes from the connection**, never the frame; dispatch targets `playerKey(player.id)` and the
  avatar's entity host (absent for a spectator, whose `player.avatar` throws).
- **Interactions drain here too**, after the action edges, so a press that opened a menu and a press on that
  menu's button arriving in one wake resolve in the order the player made them. They are queued on the
  `Connection` at receive and dispatched in the pass, because a handler reached from a socket callback would
  run between ticks against whatever tick the loop last adopted. Dispatch goes through core's `pressWidget` /
  `pointerHit`, never a second copy: the screen-scoping rule for a press and the liveness check for a pointer
  hit are the same on both endpoints. The entity a hit names is the peer's claim — it was resolved against a
  camera the server does not hold — so it is checked for liveness and nothing more, and a handler that grants
  something must check reach itself.
- **Stale-hold backstop:** after `holdStaleTicks(simRate)` with no traffic, every held action is released and every
  axis returned to neutral — the crash / killed tab / yanked cable a client blur handler cannot cover. **Any**
  well-formed frame counts as traffic, because edges-only input means a player holding one button sends
  nothing; `TimeSync` is the only thing a live client sends unprompted, so it is what liveness means.

### 4.3 Admission

In order, per frame: a **seq sanity bound** — above the frontier, and within `maxSeqGap` of `highestSeen`,
refused before the gap-dating map can be made to cost O(seq). At or below the frontier the seq is already
resolved, so no ack could report it and applying it would re-fire an edge the loop has walked past: a
replay, or a late arrival `abandonStale` gave up on. Then the **tick window**
`[tick − pastGrace, tick + futureHorizon]`, where inside-grace is buffered and merge-forwarded, up to
`HORIZON_CLAMP_TICKS` past the horizon is **clamped** to the horizon, and further out is `too-far-future`;
then the **token bucket** (`INPUT_BUCKET_FRAMES` deep, one token refilled per stepped tick — the wire's own
one-frame-per-tick ceiling, with depth for a multi-tick wake's burst). Identity needs no check here: no
frame field names a player. A refusal is reported by the ack advancing past it (§4.4) — there is no
`InputNack`. `RATE_BREACH_CLOSE` cumulative rate refusals close that connection alone.

Those three bound how **many** frames arrive; three more bound what **one** frame may contain, since none
of the above sees a frame's shape — transport refuses a frame over `MAX_FRAME_BYTES` before parsing it, but
byte size says nothing about how much per-tick work the contents buy. The narrowing caps `actions[]` at `MAX_ACTIONS_PER_FRAME` and each name
at `MAX_ACTION_NAME_LENGTH`, and admission caps the distinct names a connection may open at
`MAX_ACTION_NAMES` — a held name buys a synthesized `hold` dispatch every tick for as long as it is held,
so an unbounded key space is unbounded per-tick work bought with one frame. An axis `value` must also be
**finite**: it reaches `fillIntent` unmodified and core writes it straight into a `Float64Array`, so one
`Infinity` poisons the world permanently. A frame failing any of these is dropped whole and unresolved, so
its seq stalls the ack like a frame that never arrived until `abandonStale` releases it.

`join-request` and `time-sync` draw on a **second, far shallower bucket** (`CONTROL_BUCKET_FRAMES`, one
token per `CONTROL_REFILL_MS`) that the input bucket does not cover: a resync buys a full world walk and a
`time-sync` buys a reply, and nothing else rate-limits either. `interaction` draws on the **input** bucket
instead — it is the same shape of cost as an input frame, one per tick with bounded contents, and one
bucket is what keeps a peer's _total_ per-tick work bounded rather than letting a second channel double it.
Its narrowing caps `events[]` at `MAX_INTERACTIONS_PER_FRAME` and each widget or screen name at
`MAX_WIDGET_NAME_LENGTH`; there is no distinct-name cap, because a press buys one dispatch and is gone,
where a held action buys one every tick until it is released.

Two more bounds, on state a frame is not needed to open: `JOIN_DEADLINE_MS` (swept after each `pump`,
against the pump's own clock, since `TimerSource` schedules but does not tell time) and
`MAX_UNJOINED_CONNECTIONS`, **distinct** from `maxPlayers` so unjoined sockets cannot lock out real players.
Input before the join is dropped — there is no player to attribute it to.

Every window and cap constant is stated in **milliseconds** and converted per `simRate`: a tick count sized
for 60 Hz is three times the wall-clock window at 20 Hz.

### 4.4 `ackSeq` is the highest contiguous **resolved** seq

Resolved = applied **or** definitively rejected. So a refusal advances the ack past itself (nothing stalls
in the client's ring), while a **gap holds it back** (the client still owes that seq a replay). A frame
buffered for a future tick resolves at the apply, not at arrival — acking it early would let the client
prune input it needs. `AdmissionState` keeps the frontier, the resolved-above-frontier set, and per-seq
`headroom` (`frame.tick − serverTickOnArrival`, already computed for the window check); `takeAck()` walks
the frontier forward and reports `earliestHeadroom` for the earliest input that ack resolved — **absent**,
never `undefined`, on a quiet tick. A seq that never arrived is datable (`seq` and `tick` advance
together), so `abandonStale` releases it once its latest possible tick falls out of the past grace. That
same arithmetic sizes `maxSeqGap` to the window rather than to a round number: a seq further ahead than the
window is wide names a tick nothing could apply, so admitting it would only buy the gap-dating walk.

---

## 5. Stepping and broadcast

### 5.1 Step every tick; drain and broadcast on a send-tick

Per tick: refill each connection's tokens → `Loop.step(rt.tick + 1)` → `abandonStale`. On a send-tick
(every `simRate / sendRate` ticks): `drainOnce`, fan out to every joined connection **except** those
awaiting a `Welcome`, then answer those pending joins.

**The `Welcome` is built here, immediately after the drain** — a snapshot taken at `JoinRequest` time sits
on the wrong side of the journal cut, and the joiner's first envelope would replay ops its snapshot already
holds. A duplicate `spawn` is not idempotent: the client mints a second entity and orphans the first. Cost
is one send interval of join latency. Drains are on the send-tick, not every tick, because core's channels
accumulating between sends _is_ the net-change accumulation.

**Ops held over are the same hazard.** A snapshot reads live state, so it already contains the effect of
everything still in the spill queue (§5.3) — a joiner is therefore stamped with
`Connection.structuralSkip = spill.length` when its `Welcome` goes out, and drops that many ops off the
front of the envelopes that follow. Counted down rather than cleared, since a spill deeper than one send's
budget spans several sends.

**A `Welcome` over `MAX_FRAME_PAYLOAD_BYTES` is divided** (`chunk.ts`): the snapshot's `entities` and
`state` move into `snapshot-chunk` envelopes sent **before** it, and the `Welcome` carries
`snapshotChunks` naming how many. Encoded once and measured, then sent as the frame that was measured
through `sendEncoded`, so a world that fits pays nothing for the check. `splitSnapshot` sizes groups by
**measuring** each element rather than counting them — `template`, `tags` and a `@serverState` value are
all creator-authored, so element count says little about bytes — and an element no frame could carry alone
is dropped and counted, like an unrepresentable mark. The tick and the roster stay on the `Welcome`: one is
a scalar and the other is bounded by `maxPlayers`.

**The render manifest is live, not captured.** `ManifestStore` holds every visual declared so far, keyed by
name so a re-declaration costs nothing, and queues whatever is genuinely new. `declareVisuals(manifest)` is
how a template comes into use mid-session; the additions go out as a `manifest` envelope **before** the
fan-out on the next send-tick, because that same send's journal may carry the first spawn of one and a node
created against a table that lacks the template draws the placeholder and keeps it. A connection still
awaiting its `Welcome` is skipped, since `snapshot()` already gives it the whole manifest — so a joiner and
an already-connected peer cannot end up able to draw different things. Assets are defined on core's registry
alongside, or `assets.get` answers `null` for a key the wire is already carrying.

### 5.2 Two envelopes, both tick-stamped

Protocol's types, split by reliability class and joined by an equal `tick`:

- **`StateEnvelope`** (reliable, per connection) — `tick`, `ackSeq`, `earliestHeadroom?`, `structural`,
  `state`. Per-connection by construction, so it cannot be encoded once.
- **`TransformEnvelope`** (droppable, shared) — `tick` plus whole-transform diffs; identical for every peer,
  so it is the encode-once subset.

### 5.3 The drain: three channels to one `SendSet`

Nothing sits between the drain and the envelope. `drainOnce` runs once per send-tick (each drain clears what
it consumes, so a per-connection drain would starve every connection but the first) and its `SendSet` lives
for exactly one send — except the spill queue, which is the one thing carried between them.

**The structural budget is the only bound on what the server produces.** Everything else here bounds what it
_accepts_; nothing limited a journal, so a script spawning in a loop minted an envelope past transport's
frame cap — refused by every peer before parsing, and the client's answer to a broken session is a resync,
which asks for a full snapshot and is bigger. So `MAX_STRUCTURAL_OPS_PER_SEND` caps one send and the
remainder goes to `GameServer.#spill`, at the **front** of the next send's ops and ahead of anything new.
Strictly ordered: the ops do not commute and the journal is applied verbatim, so a reordered spill creates a
node for a dead entity — worse than no cap at all. Ops are converted to wire form **before** they can be
held over, because a `spawn`'s snapshot is read from live state and an entity destroyed while its op waited
would go out with an empty `template`.

- **Roster ops core's journal has no arm for:** `player-join` is **prepended** (it must precede the spawns
  its own handler produced), `player-leave` **appended** (it must follow the destroys of that player's
  entities).
- **Structural** keeps journal order — order is meaning. `NetId` **is** the `EntityId`, cast at the
  boundary, so no map is needed server-side. Per op: `spawn` carries a full `EntitySnapshot` with
  `parent: null, tags: []` and no `overrides` (at mark time `create` has set none of the three; each arrives
  later as its own op) and a current transform; `destroy` and `attach` pass through; `reparent` maps
  `NO_ENTITY` → `null` (core's
  `detach()`); a `say:`-prefixed `tag` is **filtered** (it is not in core's tag index — speech bubbles are
  unreplicated); and a spawn-then-destroy inside one interval is dropped **as a pair**, since a released
  entity has no record and an empty `template` would abort the client's whole reconcile. A `group` converts
  arm by arm and survives whole or not at all, keeps its order, and counts against
  `MAX_STRUCTURAL_OPS_PER_SEND` by what it holds — a group over the budget on its own still goes, alone,
  because the boundary is indivisible. The switch ends in a `never` default: `noImplicitReturns` is off, so
  an unhandled arm would return `undefined` and be counted as unrepresentable rather than caught.
- **The join snapshot restates the attachments** as `EntitySnapshot.overrides.scripts`, read back off the
  instance registry through `rt.scriptIdOf` rather than off the template, because `addScript` puts classes on
  an entity no template names — and those are exactly the ones a joiner cannot infer. A class the resolver
  cannot name is left out, for the reason its `attach` op is never journaled.
- **Transform:** `consumeDirty()` returns dirty slot indices, so each is resolved to an id and the whole
  seven-field transform read in core's order, non-finite cells degraded to slot defaults (`jsonCodec` throws
  on `NaN`, which would abort the send for every peer). A read, never a write.
- **State:** marks are addressed through a table built **forward** from `GAME_KEY`, the roster and
  `liveIds()` using core's own `playerKey`/`entityKey` — a core rename becomes a compile error, and a mark
  naming a dead host misses the table and is counted as `server.staleMarks`, apart from `droppedMarks`
  because a write whose host dies inside the same send interval is churn rather than a defect. A field is read by one function, `encodeHostField`,
  which `buildSnapshot` calls too, so neither path can keep a field the other discards. Values inside it go
  through `encodeStateValue` (`Entity` → netId,
  `Player` → id, plain objects/arrays recursed, cycle- and depth-guarded); game/entity marks are shared,
  player marks scoped to their owner, and one bucket per host so an address is named once however many
  fields it wrote. Anything unrepresentable is **dropped and counted** (`server.droppedMarks`) rather than
  thrown — including a field named `__proto__` / `constructor` / `prototype`, transport's `RESERVED_KEYS`
  rather than a second copy of the set, since the grouped shape makes the name a KEY and assigning one would
  set the bucket's prototype rather than add it — checked at **every** level of a value, not only the top,
  since a serialized wrapper is a nested object and a reserved key inside one would set the copy's prototype
  and ship the field silently short a member. Values are read through core's `serializeHostField`, so a
  wrapper field crosses as its `serialize()` form: read raw it is a class instance, which `encodeStateValue`
  refuses, and every scoreboard write would be dropped and counted here.

### 5.4 Fan-out

A loop over the registry, reliable envelope first (the client holds a transform envelope until the state
envelope for that tick is applied). The transform frame is encoded lazily and memoised on the `SendSet`, so
N connections still cost one `codec.encode`. Most of a state envelope is per-connection (`ackSeq`,
`earliestHeadroom`, scoped state), so the transform frame is the whole of the shared subset. `send` and
`sendEncoded` after a peer's `close()` are silent no-ops, and each connection's turn additionally sits in
its own `try`/`catch` that logs `send-failed`, closes that peer and continues — an encode or a socket
write is not this package's code, and one throw would otherwise end the broadcast for every peer behind
it in the registry. Inside that turn `pendingJoin` is cleared **after** the `Welcome` reaches the wire:
cleared first, a peer whose reply threw would read as broadcast-ready with no baseline behind it.

---

## 6. The driver

### 6.1 Accumulator → ticks

`pump(nowSeconds)` calls `deliver` (§6.4), **discards** a non-finite reading (storing it would `NaN` the
counter for the whole session), clamps a backwards clock to zero, then steps while
`accumulator >= dt − STEP_EPSILON` and under the cap. The epsilon (1 ns) exists because a host advancing by
exactly `1 / simRate` accumulates slightly less than `dt`, and a wake owing one tick would step zero times.
It returns `{ steps, sends, shed }`, so cadence and shedding are observable without reading `rt.tick`, and
`GameServer.shedCount` reports the cumulative count.

### 6.2 The step cap sheds wall-clock, never ticks

`maxStepsPerWake(simRate)` (`MAX_CATCHUP_MS`) bounds one wake; if the cap is hit **with backlog left**, the
accumulator is zeroed and `shedCount` increments — a bounded visible slowdown instead of the spiral of
death. Conditioning on leftover backlog matters: a wake that needed exactly the cap and drained cleanly has
a legitimate remainder to keep.

The **tick counter stays contiguous** — `stepOnce` always steps `tick + 1`. This is forced by core, not
preferred: timers and tweens advance one unit per `step()` call regardless of index and `dt` is always
`1 / simRate`, so stepping `tick + N` would compress every `after`, `every`, `sleep` and tween by the gap.
Input buffered for a skipped tick is merge-forwarded (§4.1), so a shed costs latency, not existence, and
shows up as a late `ackSeq` rather than a vanished input.

### 6.3 Send cadence and the rate frames

`ticksPerSend(simRate, sendRate)` is counted **on the driver**, not derived from `rt.tick % N`, so a
mid-session `setSimRate` cannot desync it. Both rates reach the client: `Welcome.sendRate` from the
server's own config (core resolves none), `TimeSync` is answered with `TimeSyncReply` echoing
`clientSentMs` **byte-identically** (only the client may difference its own stamps), and
`GameServer.setSimRate` retunes core and the driver and emits `RateChange` to every joined connection — a
resync trigger for the client, since core retunes neither pending timers nor the lag ring. Nothing on the
creator surface can produce one. `server.config` reports the **live** `simRate`, read off the runtime rather
than off the load-time resolved config, which a rate change leaves stale.

### 6.4 The driver owns `deliver`→step

One `pump`, two drivers, and the **driver** calls `deliver` itself, first. The host never sequences the
two: reversed, it still runs and nothing reports it, costing every input one tick of latency that hides
inside loopback's existing one-tick outbound delay and becomes a real floor in production.

- **Loopback:** the composition root passes `deliver: pair.deliver` and calls `pump(now)` per iteration.
- **Networked:** `deliver` is omitted (the socket's event loop already dispatched inbound), and
  `start()`/`stop()` self-drive off the injected `TimerSource` at `1000 / simRate` ms, reading `now` if one
  was injected — otherwise the interval is the clock, a fixed-step loop with no drift correction. `start()`
  **throws** with no timer injected: a no-op self-drives nothing, and the server would simply never tick.

Mode-awareness is that one optional field: a value, not an ordering obligation.

---

## 7. Disconnection

`onClose` (clean close, transport drop, or an admission-breach close) → mark closed, remove from the
registry so the next broadcast skips it, drop the connection's buffered frames, run the disposers once,
then release the player: **destroy its owned entities first** (found by scanning `liveIds()` for
`record.ownerId`, never `player.avatar`, which throws for a spectator), then `leavePlayer(rt, id)` — which
dispatches `@onPlayerLeave` at the Game host **before** `PlayerManager.remove`, so the handler can still
read the player — then **persist** that player's host record, then queue the `player-leave` op. No grace
period and no reconnect.

Persistence is the seam's two missing halves, filled here: `ServerConfig.kv` is assigned to `rt.kv` and a
`PersistedState` over it becomes `rt.persisted`, which is what wiring's seeding has always read and nothing
ever produced. The read is at the join and **before** `joinPlayer`: wiring seeds a field synchronously at the
hoist and `@onPlayerJoin` attaches the player's own scripts inside that call, so a record arriving after it
would seed nothing until the session after, and a host the cache already holds is never re-read since `save`
captured it synchronously. The record reference is taken **before** `leavePlayer` and read **after** it — the leave
handler may write a last value, and `PlayerManager.remove` then drops the record from the host table, so
neither order alone works. Only a **host-named** connection is written back, and only when the cache holds
its record: a `connectionId` is minted fresh per socket, so a record saved under one is unreadable by
anything and a join/leave loop would leak a durable entry per cycle, while a record the cache does not hold
under a host-supplied identity means the read failed and this session's initializers must not overwrite it.
The write is fire-and-forget with the failure routed to `rt.log.warn` — the trigger is a socket that has
already closed, and `transport.onClose` has nowhere to put a promise — but the promise is retained until it
settles, because `GameServer.close()` does have somewhere: it returns one. `PersistedState` captures
synchronously into its cache for the same reason, so a rejoin under the same host id reads the value back
whether or not the store write has landed.

`GameServer.close()` is the whole-server form: stop the driver, then run that path **inline** for every
connection rather than waiting on each transport's `onClose`, which arrives on the next delivery — and after
a close there is no next delivery, so waiting would leak every `Player` and every registered handler. It
returns a **`Promise<void>`** that settles once every save still in flight has, so a host that exits on it
does not drop the state of every player who was online; `allSettled` over them rather than `all`, since a
store that rejects must release the drain rather than hold the shutdown open on the one write that will
never land. Idempotent: a second call returns the first one's drain. Afterwards `pump` is inert, `accept`
returns `null`, and `start()` throws. `stop()` remains the narrower verb: it parks the driver and leaves
every connection open.

---

## 8. Conventions

`NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where type-only, no
cycles. The exported barrel drives core only as values (`loadGame`, `Loop`, `Runtime`) and declares no
script, so nothing on this package's surface carries a decorator.

Everything this package throws is a `ServerError` carrying a `ServerErrorCode`, so a host branches on the
code rather than on message text: `invalid-config` and `invalid-argument` are the caller's to fix,
`no-pass-table` is a wiring fault, `no-timer` and `server-closed` are lifecycle misuse. Engine constants
live in `constants.ts`, grouped by unit, never on the creator surface:

| Constant                      | Value                 | Bounds                                                 |
| ----------------------------- | --------------------- | ------------------------------------------------------ |
| `INPUT_WINDOW_MS`             | `MAX_REWIND_MS` (250) | both sides of the tick window (§4.3)                   |
| `JOIN_DEADLINE_MS`            | 5 000                 | silence before an unjoined connection is closed        |
| `HOLD_STALE_MS`               | 5 000                 | silence before held actions are released server-side   |
| `MAX_CATCHUP_MS`              | 250                   | wall-clock one wake may catch up before shedding       |
| `INPUT_BUCKET_FRAMES`         | 8                     | input-frame token depth, one refilled per stepped tick |
| `RATE_BREACH_CLOSE`           | 64                    | cumulative rate refusals before the connection closes  |
| `CONTROL_BUCKET_FRAMES`       | 4                     | `join-request` + `time-sync` token depth               |
| `CONTROL_REFILL_MS`           | 1 000                 | wall-clock per control token                           |
| `MAX_ACTIONS_PER_FRAME`       | 32                    | actions one input frame may carry                      |
| `MAX_ACTION_NAME_LENGTH`      | 64                    | longest accepted action name                           |
| `MAX_ACTION_NAMES`            | 64                    | distinct action names one connection may open          |
| `MAX_INTERACTIONS_PER_FRAME`  | 16                    | interactions one frame may carry                       |
| `MAX_WIDGET_NAME_LENGTH`      | 64                    | longest accepted widget or screen name                 |
| `MAX_NAME_LENGTH`             | 24                    | longest accepted display name, in code points          |
| `MAX_IDENTITY_LENGTH`         | 128                   | longest accepted `projectId` / hash on a join request  |
| `MAX_STATE_DEPTH`             | 64                    | `@serverState` nesting past which a value is dropped   |
| `MAX_UNJOINED_CONNECTIONS`    | 32                    | unjoined sockets held at once                          |
| `HORIZON_CLAMP_TICKS`         | 2                     | ticks past the horizon clamped rather than refused     |
| `MAX_STRUCTURAL_OPS_PER_SEND` | 2 048                 | structural ops one send carries; the rest spill        |
| `MAX_FRAME_PAYLOAD_BYTES`     | ¾ `MAX_FRAME_BYTES`   | bytes a server-minted frame targets, under the cap     |

`pastGraceTicks` / `futureHorizonTicks` / `holdStaleTicks` / `controlRefillTicks` / `maxStepsPerWake` /
`ticksPerSend` convert these to ticks of the session's own rate, and `maxSeqGap` composes the first two with
`HORIZON_CLAMP_TICKS` rather than naming a bound of its own. `MAX_STATE_DEPTH` is the one that is not a
policy choice: it must stay far below the codec's own 128-level cap, which the envelope's own nesting eats
into, because a value the encoder passes and the codec refuses throws out of the fan-out.

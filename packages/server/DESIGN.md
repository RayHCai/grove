# `@platform/server` — internals

**TL;DR.** The authority process. It holds the one core `Runtime`, advances real time into ticks off an
**injected** clock, admits and buffers untrusted client input per intended tick, and drains core's three
replication channels onto the wire every send-tick. It sits between `@platform/transport` (opaque frames)
and `@platform/core` (simulation, no clock, no network) — the seam where core's `ReplicationSink`
obligation is met and a `Transport` per player is held. `@platform/client` is its wire peer; they share
only `@platform/protocol`, which is authoritative for every envelope shape. The server is **policy**:
which tick an input applies to, whether it is admissible, when to broadcast, what each connection is
owed. It never opens a socket, never reads `Date.now()`, and never re-implements the tick order.

It is driven today by a scripted clock over `loopbackPair`; a WebSocket listener belongs to the composition
root, which `accept` is already shaped for.

| File                  | Holds                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `server.ts`           | `GameServer`: registry, `accept`, join/reject/resync, `pump`, `setSimRate`, close path    |
| `connection.ts`       | `Connection` record; `AdmissionState` (resolution frontier, headroom, token bucket)       |
| `input.ts`            | `InputBuffer` (tick-keyed, `drainThrough`), the admission checks, `runInputPass`          |
| `driver.ts`           | `Driver`: accumulator, step cap + shed, send cadence, `deliver`→step, self-driven `start` |
| `broadcast.ts`        | the three drains → `SendSet`, wire retyping, `encodeStateValue`, per-connection fan-out   |
| `snapshot.ts`         | `buildSnapshot` — the join-time world walk; `ancestorsFirst`                              |
| `constants.ts`        | engine constants, in ms with per-`simRate` tick conversions                               |
| `testkit/fixtures.ts` | decorated script fixtures, compiled by `tsc` for the tests (not public surface)           |

---

## 1. Scope

**Owns.** Connection acceptance and the registry; player allocation at join and the join reply;
construction of the authoritative world via `loadGame`; the real-time→tick accumulator, its step cap and
shed policy; the tick-indexed input buffer and its jitter scheduling; admission (identity, window, rate,
plus join deadline and unjoined cap); `hold` synthesis and movement `intent`; the call into `Loop.step`;
the post-step drain of core's three channels into tick-stamped envelopes.

**Does not own.** Encoding (an injected `Codec`) or envelope shapes (`@platform/protocol`); the
simulation (core); a frame's reliability class or byte movement (transport); prediction and interpolation
(client). Depends on `core`, `protocol`, `transport`, `math`. Never imports `client` or `renderer`.

---

## 2. The core surface it drives

Core exports no `createWorld` / `step(tick, inputs)` / `collectChanges`; this is the real mapping.

| Need                | Core's surface                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| build the world     | `loadGame({ role: 'server', … })` → `Runtime`, then `startGame(rt)`                              |
| location filter     | `role: 'server'` → `activeLocationsFor('server')` = `['server','synced']`                        |
| step one tick       | `new Loop(rt).step(rt.tick + 1)` — **takes no inputs**                                           |
| apply input         | `rt.passes.input(dispatch)`, whose stub the server replaces (§4.2)                               |
| "collect changes"   | three drains: `channels.drainStructural()`, `channels.drainState()`, `transforms.consumeDirty()` |
| roster              | `joinPlayer(rt, id, name)` / `leavePlayer(rt, id)`, `rt.playerManager.players`                   |
| reads for snapshots | `entities.liveIds()`/`record`/`idAt`, `tags.tagsOf`, `transforms.*`, `hosts.get`                 |
| services            | left at core's null seams (`ManualClock`, `MemoryKVStore`, `NullPhysicsSink`, …)                 |

---

## 3. Connection and join

### 3.1 A registry over a `Transport` factory

`Transport` is one end of one established connection, so the multiplexer transport declined to hold lives
here: `Map<connectionId, Connection>`. Keyed by a **server-minted `connectionId`, never by player id**, so
a future reconnect rebinds a new `Transport` to the same `Player`. `accept(transport)` returns the id, or
**`null`** for a socket it refused and closed — an id for a dead socket reads at the composition root as a
live connection. The composition root feeds it from `loopbackPair()` or (later) a WebSocket listener.

`Connection` carries `transport`, nullable `player`, `pendingJoin`, one `ActionStates` fold (core's, not a
second implementation), `AdmissionState`, `disposers`, `acceptedAtSeconds` (null until the first wake
observes it — the injected clock's epoch is unknown), and `closed`.

### 3.2 The client speaks first

`accept` mints the id, registers `onMessage`/`onClose` **before** any state mutation, enforces
`MAX_UNJOINED_CONNECTIONS`, and sends nothing. The first valid `JoinRequest` then: checks
`protocolVersion`, checks `maxPlayers`, calls `joinPlayer` (which fires `@onPlayerJoin`, whose handler
spawns or spectates), sanitizes the name (NFC, Unicode control **and format** characters stripped, ≤24
**code points**, blank → `player`), stores `pendingJoin`, and queues a `player-join` roster op. The
`Welcome` itself is built at the next send-tick (§5.1). `index` is assigned by core's `PlayerManager`,
never by the server.

A refusal is `Reject { reason, serverProtocolVersion }` **then** `close()` — a bare close is
indistinguishable from a drop, and `version` must never be retried while `full` is not a network error at
all. `maxPlayers` is deliberately absent from `Welcome`. Inbound frames are narrowed structurally, not
cast (`join-request`, `input`, `time-sync` only); anything unrecognized is ignored and the connection
survives. A **resync** re-sends `JoinRequest` on a joined connection: it re-arms `pendingJoin` and
allocates no second `Player`, and it spends a control token (§4.3) — a resync is the most expensive thing
a single frame can ask for.

### 3.3 The join snapshot is a walk of the live world

A joiner holds nothing, so it needs a complete picture; core's channels are deltas and `Loop.snapshot()`
is the private rewind form. `buildSnapshot(rt, forPlayer)` therefore reads live structures: `tick`,
entities in `ancestorsFirst` order, the roster, and `@serverState` from **three** sources — all
game-record fields, this player's own player-record fields (player-hosted state is scoped to its owner),
and every live entity's entity-record fields.

`ancestorsFirst` is a real topological emit, not core's slot order: parenting is a post-hoc mutation, so
`spawn(child); spawn(parent); child.attachTo(parent)` leaves the child in the lower slot, and the wire
requires parents first. It is iterative and `seen`-guarded, roots a child whose parent is not live, and
still ships anything a cycle stranded.

**There is no per-tick mirror.** One would pay O(players × dirty) writes per tick to serve a read that
happens once per join, and delta replication needs per-connection _acked baselines_ — a
single current-tick view is the one version no connection is behind at.

### 3.4 Constructing the world

One runtime, once, in the constructor: `loadGame({ role: 'server', simRate, bounds, regions?, assets?,
gameScripts? })`, then the input pass is installed **before** the first step, then the driver is built,
then `startGame(rt)` is called and **not awaited** — its promise settles when every `@onStart` completes,
and a handler awaiting a timer cannot complete until the loop steps, so awaiting it deadlocks the server
against its own driver. The synchronous run to each first `await` is the guarantee that matters; `server.started`
exposes the promise for a host that wants it. `ServerConfig` extends `Partial<EngineConfig>` and adds
`bounds`, `regions`, `visuals` (`RenderManifest` → `Welcome.visuals`; core's asset registry holds no
`url`) and `gameScripts`. Defaults: `simRate` 60, `sendRate` 20, `maxPlayers` 8, bounds ±400 × ±300 —
and both rates and `maxPlayers` are **validated** here, because `resolveConfig` fills defaults without
checking and a `simRate` of 0 makes `dt` infinite, so the accumulator never reaches it and the world steps
zero times forever. A missing `rt.passes` throws for the same reason: silently keeping core's stub leaves
every input unapplied, which reads as a dead game rather than a wiring fault.

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

Installed over core's stub, it runs at tick order step 2–3: `advanceTick()` once per connection (so
one-tick-wide `pressed`/`released` clear even on a quiet tick), then the drained frames are folded through
core's `applyEdge` and dispatched, then per connection the stale-hold backstop, the synthesized `hold`, and
`movement.fillIntent(moveX, moveY)`.

- **`hold` is synthesized, not received.** The client sends edges only, but `@onEvent(…, { on: 'hold' })`
  fires every tick while held — so a wire `hold` sample updates the axis and dispatches nothing of its own,
  and the pass dispatches `hold` for held buttons **union** non-neutral axes (an axis never enters `held`).
- **`fillIntent` runs here**, ahead of movement's step 4; without it `intent` stays zero and nothing moves.
- **Identity comes from the connection**, never the frame; dispatch targets `playerKey(player.id)` and the
  avatar's entity host (absent for a spectator, whose `player.avatar` throws).
- **Stale-hold backstop:** after `HOLD_STALE_TICKS` with no traffic, every held action is released and every
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
`time-sync` buys a reply, and nothing else rate-limits either.

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

### 5.2 Two envelopes, both tick-stamped

Protocol's types, split by reliability class and joined by an equal `tick`:

- **`StateEnvelope`** (reliable, per connection) — `tick`, `ackSeq`, `earliestHeadroom?`, `structural`,
  `state`. Per-connection by construction, so it cannot be encoded once.
- **`TransformEnvelope`** (droppable, shared) — `tick` plus whole-transform diffs; identical for every peer
  until interest management lands, so it is the encode-once subset.

### 5.3 The drain: three channels to one `SendSet`

Nothing sits between the drain and the envelope. `drainOnce` runs once per send-tick (each drain clears what
it consumes, so a per-connection drain would starve every connection but the first) and its `SendSet` lives
for exactly one send.

- **Roster ops core's journal has no arm for:** `player-join` is **prepended** (it must precede the spawns
  its own handler produced), `player-leave` **appended** (it must follow the destroys of that player's
  entities).
- **Structural** keeps journal order — order is meaning. `NetId` **is** the `EntityId`, cast at the
  boundary, so no map is needed server-side. Per op: `spawn` carries a full `EntitySnapshot` with
  `parent: null, tags: []` (at mark time `create` has set neither; both arrive later as their own ops) and a
  current transform; `destroy` and `attach` pass through; `reparent` maps `NO_ENTITY` → `null` (core's
  `detach()`); a `say:`-prefixed `tag` is **filtered** (it is not in core's tag index — speech bubbles are
  unreplicated); and a spawn-then-destroy inside one interval is dropped **as a pair**, since a released
  entity has no record and an empty `template` would abort the client's whole reconcile.
- **Transform:** `consumeDirty()` returns dirty slot indices, so each is resolved to an id and the whole
  seven-field transform read in core's order, non-finite cells degraded to slot defaults (`jsonCodec` throws
  on `NaN`, which would abort the send for every peer). A read, never a write.
- **State:** marks are addressed through a table built **forward** from `GAME_KEY`, the roster and
  `liveIds()` using core's own `playerKey`/`entityKey` — a core rename becomes a compile error, and a mark
  naming a dead host misses the table and is dropped. Values go through `encodeStateValue` (`Entity` → netId,
  `Player` → id, plain objects/arrays recursed, cycle- and depth-guarded); game/entity marks are shared,
  player marks scoped to their owner, and one bucket per host so an address is named once however many
  fields it wrote. Anything unrepresentable is **dropped and counted** (`server.droppedMarks`) rather than
  thrown — including a field named `__proto__` / `constructor` / `prototype`, since the grouped shape makes
  the name a KEY, and assigning one would set the bucket's prototype rather than add it.

### 5.4 Fan-out

A loop over the registry, reliable envelope first (the client holds a transform envelope until the state
envelope for that tick is applied). The transform frame is encoded lazily and memoised on the `SendSet`, so
N connections still cost one `codec.encode`. Most of a state envelope is per-connection (`ackSeq`,
`earliestHeadroom`, scoped state), and delta replication plus interest management will shrink the shared
subset further. No try/catch per send: `send`/`sendEncoded` after a peer's `close()` are silent no-ops, so
one dead peer cannot abort the fan-out.

---

## 6. The driver

### 6.1 Accumulator → ticks

`pump(nowSeconds)` calls `deliver` (§6.4), **discards** a non-finite reading (storing it would `NaN` the
counter for the whole session), clamps a backwards clock to zero, then steps while
`accumulator >= dt − STEP_EPSILON` and under the cap. The epsilon (1 ns) exists because a host advancing by
exactly `1 / simRate` accumulates slightly less than `dt`, and a wake owing one tick would step zero times.
It returns `{ steps, sends, shed }`, so cadence and shedding are observable without reading `rt.tick`.

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
read the player — then queue the `player-leave` op. No grace period and no reconnect;
connection-keying is what will make that a rebind rather than a rejoin.

`GameServer.close()` is the whole-server form: stop the driver, then run that path **inline** for every
connection rather than waiting on each transport's `onClose`, which arrives on the next delivery — and after
a close there is no next delivery, so waiting would leak every `Player` and every registered handler.
Afterwards `pump` is inert, `accept` returns `null`, and `start()` throws. `stop()` remains the narrower
verb: it parks the driver and leaves every connection open.

---

## 8. Conventions

`NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where type-only, no
cycles. `src/` drives core only as values (`loadGame`, `Loop`, `Runtime`) and declares no script, so core's
decorator-toolchain caveats apply to `testkit/fixtures.ts` alone. Engine constants live in `constants.ts`,
grouped by unit, never on the creator surface:

| Constant                   | Value                 | Bounds                                                 |
| -------------------------- | --------------------- | ------------------------------------------------------ |
| `INPUT_WINDOW_MS`          | `MAX_REWIND_MS` (250) | both sides of the tick window (§4.3)                   |
| `JOIN_DEADLINE_MS`         | 5 000                 | silence before an unjoined connection is closed        |
| `HOLD_STALE_MS`            | 5 000                 | silence before held actions are released server-side   |
| `MAX_CATCHUP_MS`           | 250                   | wall-clock one wake may catch up before shedding       |
| `INPUT_BUCKET_FRAMES`      | 8                     | input-frame token depth, one refilled per stepped tick |
| `RATE_BREACH_CLOSE`        | 64                    | cumulative rate refusals before the connection closes  |
| `CONTROL_BUCKET_FRAMES`    | 4                     | `join-request` + `time-sync` token depth               |
| `CONTROL_REFILL_MS`        | 1 000                 | wall-clock per control token                           |
| `MAX_ACTIONS_PER_FRAME`    | 32                    | actions one input frame may carry                      |
| `MAX_ACTION_NAME_LENGTH`   | 64                    | longest accepted action name                           |
| `MAX_ACTION_NAMES`         | 64                    | distinct action names one connection may open          |
| `MAX_NAME_LENGTH`          | 24                    | longest accepted display name, in code points          |
| `MAX_STATE_DEPTH`          | 64                    | `@serverState` nesting past which a value is dropped   |
| `MAX_UNJOINED_CONNECTIONS` | 32                    | unjoined sockets held at once                          |
| `HORIZON_CLAMP_TICKS`      | 2                     | ticks past the horizon clamped rather than refused     |

`pastGraceTicks` / `futureHorizonTicks` / `holdStaleTicks` / `controlRefillTicks` / `maxStepsPerWake` /
`ticksPerSend` convert these to ticks of the session's own rate, and `maxSeqGap` composes the first two with
`HORIZON_CLAMP_TICKS` rather than naming a bound of its own. `MAX_STATE_DEPTH` is the one that is not a
policy choice: it must stay far below the codec's own 128-level cap, which the envelope's own nesting eats
into, because a value the encoder passes and the codec refuses throws out of the fan-out (§9).

---

## 9. What implementing it corrected

| The doc claimed                                                            | The fact                                                                                                                                                                                                                                                                                | Caught by                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| §5.3: anything unrepresentable is dropped and counted, never thrown        | True for `undefined` and cycles, not for depth: the guard sat at 128, the codec's own cap, which the envelope's nesting eats into — so a value at depth ≥125 passed the encoder and threw out of `encode`, aborting the fan-out for every connection and escaping `pump`. Now 64.       | `tests/admission.test.ts`, wrapping an accepted value in the deepest envelope it can ride |
| §4.3: every check here exists because a frame cannot be trusted            | All four bounded how **many** frames arrive. None bounded one frame's `actions[]`, its action-name length, or the key space those names open in core's fold — where a held name costs a `hold` dispatch every tick, so one frame bought unbounded per-tick work for the session.        | Reading `createActionStates`' unbounded `held` / `axis` maps against `activeActions`      |
| §6.4: `start()`/`stop()` self-drive off the injected `TimerSource`         | With no timer injected it returned silently, so a networked host calling `start()` got a server that never ticked and no error. It throws now.                                                                                                                                          | `tests/admission.test.ts`                                                                 |
| §7: `onClose` is the close path                                            | It was the **only** one, so there was no way to shut a server down: `stop()` parks the driver, and a transport's `onClose` needs a delivery that a parked driver never makes — every `Player` and every handler leaked. `close()` runs the path inline.                                 | `tests/admission.test.ts`                                                                 |
| §4.3: a seq bound of `MAX_SEQ_GAP` (1 024)                                 | Thirty-two times wider than it can be used: one frame per tick is the wire's ceiling, so a seq past the window names a tick nothing could apply — the extra 992 bought only gap-dating. `maxSeqGap` is now the window. A duplicate below the frontier was also admitted and re-applied. | `tests/input.test.ts`, replaying a resolved seq against a `Recorder`                      |
| §3.1: `accept(transport)` returns the id                                   | It returned one for a socket it had just refused and closed, so the composition root could not tell a live connection from a dead one. `null` on refusal.                                                                                                                               | `tests/admission.test.ts`                                                                 |
| §3.4: the config defaults                                                  | `resolveConfig` fills them without validating anything, so `simRate: 0` reached the accumulator as an infinite `dt` and stepped zero times forever. Validated at the constructor, alongside a missing `rt.passes`.                                                                      | `tests/admission.test.ts`                                                                 |
| §3.2: the name is sanitized — control chars stripped, ≤24 chars            | C0 and DEL only, leaving bidi overrides and zero-width characters that reorder every name beside them; and the cap counted UTF-16 units, so it could split a surrogate pair into a lone half. Now NFC, `\p{Cc}`+`\p{Cf}`, capped by code point.                                         | Re-reading the strip against what a display name is rendered into                         |
| §5.4: no try/catch per send, because a closed peer's send is a no-op       | Confirmed. Transport documents `send`/`sendEncoded` after `close()` as silent no-ops, so a peer dropping between the step and the send cannot abort the fan-out — but it covers only close, not an `encode` throw, which is why the two guards above matter.                            | `tests/broadcast.test.ts`'s dropped-peer case                                             |
| §5.3: a spawn-then-destroy pair is detected by the entity having no record | Confirmed. `EntityTable.record` returns `EntityRecord \| null`, so the `=== null` test is right — but it is the one place in the package testing that API by strict equality, and an `undefined` return would ship a `destroy` for a netId the client never spawned.                    | Reading `core/src/world/entity-table.ts`'s signature                                      |

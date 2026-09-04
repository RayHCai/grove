# `@platform/sim` — internals

**TL;DR.** The deterministic fixed-step advance. It holds the one core `Runtime`, takes everything that
arrived since the last tick as one **input batch**, advances the world by exactly one tick, and hands back one
**output batch** naming every frame to write, every socket to close, and every persisted read and write it
needs. It sits between `@platform/protocol` (envelope shapes) and `@platform/core` (simulation, no clock, no
network) — the seam where core's `ReplicationSink` obligation is met. `@platform/client` is its wire peer;
they share only `@platform/protocol`, which is authoritative for every envelope shape. The sim is **policy**:
which tick an input applies to, whether it is admissible, what each session is owed. It never opens a socket,
never reads a clock, never touches a store for `@serverState`, and never re-implements the tick order.

Two hosts drive it: `@grove/host` in Rust, which runs this bundle in a V8 isolate, and `@platform/glue`'s
`GameInstance` in process. The batch holds nothing a browser cannot supply and this package imports no
`node:` anything, which is what a third host would need; `@platform/client` is not one — it re-produces
the input fold in `passes.ts` rather than importing this package.

| File               | Holds                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `batch.ts`         | `InputBatch` and `OutputBatch` — the whole seam, and the only thing that crosses it                    |
| `sim.ts`           | `Sim`: the registry, `tick`, `close`, the join/reject/resync path, `setSimRate`; the inbound narrowing |
| `session.ts`       | `Session` record; `AdmissionState` (resolution frontier, headroom, token bucket)                       |
| `input.ts`         | `InputBuffer` (tick-keyed, `drainThrough`), the admission checks, `runInputPass`                       |
| `replicate.ts`     | the three drains → `SendSet`, wire retyping, `encodeHostField` / `encodeStateValue`, the two envelopes |
| `snapshot.ts`      | `buildSnapshot` — the join-time world walk; `ancestorsFirst`                                           |
| `chunk.ts`         | `splitSnapshot` — dividing a join snapshot one frame cannot carry                                      |
| `manifest.ts`      | `ManifestStore` — the live render manifest, its join payload and its pending additions                 |
| `persisted.ts`     | `SessionRecords` — the `@serverState` cache the batch fills and the leave captures back                |
| `constants.ts`     | engine constants, in ms with per-`simRate` tick conversions                                            |
| `errors.ts`        | `SimError` and its `SimErrorCode` union — every condition this package throws on                       |
| `isolate-entry.ts` | `installIsolateEntry` — the three functions a host with no module loader reaches a bundle through      |

---

## 1. Scope

**Owns.** The session registry and what a connection is owed; player allocation at join and the join reply;
construction of the authoritative world via `loadGame`; the tick-indexed input buffer and its jitter
scheduling; admission (identity, window, rate, plus the join deadline and the unjoined cap); `hold` synthesis
and movement `intent`; the call into `Loop.step`; and the drain of core's three channels into tick-stamped
envelopes.

**Does not own.** Sockets, the clock, byte movement, and the store `@serverState` is checkpointed in — all of
which reach it through the batch. Nor encoding for the wire, envelope shapes (`@platform/protocol`), the
simulation (core), or prediction and interpolation (client). Depends on `core`, `project`, `protocol`,
`transport`, `math`. Never imports `client` or `renderer`.

---

## 2. The seam

`tick(batch: InputBatch): OutputBatch` is the whole surface, and `close(): OutputBatch` is the shutdown form.

**In.** `nowMs` (the host's wall clock), `drain` (whether this tick closes a send interval), `opened`
(connections the host authenticated), `frames` (decoded but un-narrowed), `closed`, `records` (answers to
earlier loads), `saved` (host keys whose write has landed).

**Out.** `tick`, `sends`, `closes`, `loads`, `saves`, `log`, `diagnostics`.

Three properties follow from that shape and are the reason for it.

- **Everything reaches the world at the top of a tick**, in the order the batch names — never on a socket
  callback between ticks, against whatever tick the loop last adopted. A session is a sequence of batches and
  nothing else, which is what makes one replayable.
- **A `Send` addresses a list.** `to` is `ConnectionId[]` because the transform envelope is byte-identical for
  every peer and most of a state envelope is not: the list is what tells a host which single `encode` serves
  N writes. `class` is `reliable` or `droppable`, which is the whole of the host's backpressure vocabulary —
  a droppable frame is superseded by the next of its kind and may be discarded, a reliable one may not.
- **Order inside `sends` is meaning.** A `manifest` precedes the send whose journal may spawn the first entity
  of a template it declares; `snapshot-chunk` frames precede the `Welcome` that names how many there were; a
  state envelope precedes the transform envelope for its tick; a `Reject` precedes the close in `closes`.

**Persistence is a two-batch protocol.** The sim asks with a `LoadOrder` and is answered in `records` on a
later tick, which is what makes an identified join land a turn after an anonymous one. `LoadedRecord.fields`
has three answers, not two: a record, `{}` for a host the store holds nothing under, and `null` **only** for a
read that failed. The second must be written back at the leave and the third must not — a store that could not
be read must not be overwritten with this build's initializers.

The one `Codec` the sim holds encodes nothing for the wire: it measures whether a `Welcome` fits one frame, so
it must be the codec the host encodes with.

**A host in another process reaches all of this through one global.** `installIsolateEntry(build)` publishes
`globalThis.__grove` with `boot(config)`, `tick(batch)` and `close()`, each taking and answering JSON: an
isolate has no module loader, so a global is the whole of what a host can reach, and a string is the only
shape neither side can hold a reference into. The world is built at `boot` rather than at evaluation, because
a bundle that booted when it loaded would run every Game `@onStart` before the host had a clock to advance
them with.

---

## 3. The core surface it drives

Core exports no `createWorld` / `step(tick, inputs)` / `collectChanges`; this is the real mapping.

| Need                | Core's surface                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| build the world     | `loadGame({ role: 'server', … }, { scriptIdOf })` → `Runtime`, then `startGame(rt)`              |
| location filter     | `role: 'server'` → `activeLocationsFor('server')` = `['server','synced']`                        |
| step one tick       | `new Loop(rt).step(rt.tick + 1)` — **takes no inputs**                                           |
| apply input         | `rt.passes.input(dispatch)`, whose stub the sim replaces                                         |
| "collect changes"   | three drains: `channels.drainStructural()`, `channels.drainState()`, `transforms.consumeDirty()` |
| roster              | `joinPlayer(rt, id, name)` / `leavePlayer(rt, id)`, `rt.playerManager.players`                   |
| reads for snapshots | `entities.liveIds()`/`record`/`idAt`, `tags.tagsOf`, `transforms.*`, `hosts.get`                 |
| services            | left at core's null seams, except `persisted`, which `SessionRecords` fills                      |

`rt.kv` is the one exception to "no store": it is the creator-facing `storage` a `ServerScript` **awaits**, so
it stays a promise-returning seam rather than a batch field, and a host with no store in its own process
supplies one over its own transport. It is not where `@serverState` is checkpointed, which is the load-and-save
protocol above.

---

## 4. Session and join

### 4.1 A registry keyed by the host's connection id

`Session` is one peer's half of a connection with no transport in it: `Map<connectionId, Session>`, keyed by
the **host's connection id, never by player id**, since a connection exists before it has a player and may end
without ever getting one. A session carries `identity` (the host's id for this peer, or null), `playerId`
(that identity or the connection id), `pendingJoin`, `awaitingRecord`, `admitting` (true while a load is
outstanding), `pendingTimeSync`, one `ActionStates` fold (core's, not a second implementation),
`AdmissionState`, `openedAtTick`, and `closed`.

`InputBatch.opened` carries the identity the **host** resolved, never the peer's claim: it becomes `player.id`,
so it is what persisted `@serverState` is keyed by and what every other peer sees on the wire. A connection the
sim refuses gets no session and one `CloseOrder`.

### 4.2 The client speaks first

A session is registered and sends nothing. The first valid `JoinRequest` then: checks `protocolVersion`,
checks **identity**, asks for this player's persisted record when the host named one, checks `maxPlayers` and
that no live session already holds that id, calls `joinPlayer` (which fires `@onPlayerJoin`, whose handler
spawns or spectates), sanitizes the name (NFC, Unicode control **and format** characters stripped, ≤24 **code
points**, blank → `player`), stores `pendingJoin`, and queues a `player-join` roster op. The `Welcome` itself
is built at the next send-tick. `index` is assigned by core's `PlayerManager`, never here.

**Identity is checked above capacity**, because a client running other code is refused whether or not there is
room and `full` would send it back to retry a refusal that is not about room. `ProjectIdentity` is compared,
never computed — whoever built the project knows what went into it, and a server deriving its own hashes would
be checking itself. `projectId` and `projectHash` must agree exactly; a `bundleHash` of `''` means the joiner
holds no bundle yet and will fetch the one `Welcome` names, so it is the one legal asymmetry, while a non-empty
mismatch is a client running stale code and rejects as `identity`. An omitted `config.project` declares every
field empty, which is what a client declaring none sends — so agreement, not absence, is what passes. The
resync path re-checks, since a client may have loaded a bundle since it joined.

A refusal is a `Reject { reason, serverProtocolVersion }` in `sends` **then** a `CloseOrder` — a bare close is
indistinguishable from a drop, and `version` and `identity` must never be retried while `full` is not a network
error at all. `maxPlayers` is deliberately absent from `Welcome`. Inbound frames are narrowed structurally in
`sim.ts`, not cast (`join-request`, `input`, `interaction`, `request`, `time-sync` only), against **every**
field the type declares rather than a `Partial` of it — so a frame missing the identity fields is malformed
like any other, ignored, and closed by the join deadline; the `version` reject can only refuse a peer whose
frames still parse. A **resync** re-sends `JoinRequest` on a joined session: it re-arms `pendingJoin` and
allocates no second `Player`, and it spends a control token — a resync is the most expensive thing a single
frame can ask for.

### 4.3 The join snapshot is a walk of the live world

A joiner holds nothing, so it needs a complete picture; core's channels are deltas and `Loop.snapshot()` is the
private rewind form. `buildSnapshot(rt, forPlayer)` therefore reads live structures: `tick`, entities in
`ancestorsFirst` order, the roster, and `@serverState` from **three** sources — all game-record fields, this
player's own player-record fields (player-hosted state is scoped to its owner), and every live entity's
entity-record fields — read through the same `encodeHostField` the per-tick diff uses, so a joiner's baseline
and the deltas that follow it cannot disagree about what a wrapper is or about which fields are
unrepresentable.

`ancestorsFirst` is a real topological emit, not core's slot order: parenting is a post-hoc mutation, so
`spawn(child); spawn(parent); child.attachTo(parent)` leaves the child in the lower slot, and the wire requires
parents first. It is iterative and `seen`-guarded, roots a child whose parent is not live, and still ships
anything a cycle stranded.

**There is no per-tick mirror.** One would pay O(players × dirty) writes per tick to serve a read that happens
once per join, and delta replication needs per-connection _acked baselines_ — a single current-tick view is the
one version no connection is behind at.

### 4.4 Constructing the world

One runtime, once, in the constructor, in this order: both rates are asserted **first**, because a bad rate
must refuse the construction rather than the first tick against a world that already exists; then
`loadGame({ role: 'server', simRate, bounds, regions?, assets?, templates?, entities?, gameScripts? },
{ scriptIdOf? })`, which builds the template registry, wires the Game scripts and instantiates the placed scene
against that registry — a world built against an empty registry is a world of bare entities. Then the input
pass is installed **before** the first step, then `startGame(rt)` is called and **not awaited** — its promise
settles when every `@onStart` completes, and a handler awaiting a timer cannot complete until the loop steps,
so awaiting it deadlocks the world against whatever drives it. The synchronous run to each first `await` is the
guarantee that matters; `sim.started` exposes the promise for a host that wants it. `SimConfig` extends
`Partial<EngineConfig>` and adds `bounds`, `regions`, `visuals` (`RenderManifest` → `Welcome.visuals`; core's
asset registry holds no `url`), `project` (`ProjectIdentity` → the handshake comparison and `Welcome`'s four
identity fields), `templates` / `entities` (`toGameManifest`'s output, forwarded to `loadGame`), `scripts` (a
`ScriptIndex` — one method, `idOf`, declared structurally because `@platform/scripting`'s registry imports
core), `gameScripts` and `kv`. Defaults: `simRate` 60, `sendRate` 20, `maxPlayers` 8, bounds ±400 × ±300 — and
`maxPlayers` is **validated** here, because `resolveConfig` fills defaults without checking and a head count
below one admits nobody. A missing `rt.passes` throws for a related reason: silently keeping core's stub leaves
every input unapplied, which reads as a dead game rather than a wiring fault.

`booted` is false until every step above has run, and the constructor is the only thing that can observe it:
`tick` is unreachable until it returns, so there is no window a host could offer a connection in. That is the
guarantee rather than a check — a joiner's snapshot is its entire baseline, and no later delta repairs one
taken of a world still being assembled.

`SimOptions.onBreakerTrip` is the dev channel: core hands it every handler or callback the breaker disabled,
and it is registered before `startGame` so a Game `@onStart` that trips on its first tick is still reported.
Not an envelope — a disabled handler is something whoever runs the world has to see, while a player's client
can neither act on it nor be trusted with a stack.

Every denial writes one line into `OutputBatch.log` — the three `Reject` reasons, the rate-breach close, the
join-deadline sweep, and `accept-refused` with the reason it was refused — as `event conn=<id> reason=<token>`
with any prose after a colon, because these are read by grep and a stable token is the whole point.
`accept-refused` carries no id: one is minted for a socket the sim keeps, and an id in a line for a socket it
just refused is an id a reader would go looking for. `SimOptions.log` forwards the same lines to an in-process
sink, which is a convenience for a host sharing the process and never the only channel.

---

## 5. Input and admission

This is the untrusted, adversarial boundary; every check here exists because a frame cannot be trusted.

### 5.1 The buffer is keyed by tick

`InputBuffer` files each admitted frame under the tick it will be applied on, so timing is judged on the tick
the player pressed rather than on their ping. The drain is **`drainThrough(tick)`** — every slot at or before
the stepped tick, oldest tick first — because the past grace and a host's shed both produce slots the loop has
already walked past. Late beats never: edges are not idempotent, and oldest-first preserves press-before-
release. `dropSession` clears a closed peer's pending frames.

### 5.2 The input pass

Installed over core's stub, it runs at tick order step 3–4, after the starts pass: `advanceTick()` once per
session (so one-tick-wide `pressed`/`released` clear even on a quiet tick), then the drained frames are folded
through core's `applyEdge` and dispatched, then per session the stale-hold backstop, the synthesized `hold`,
and `movement.fillIntent(moveX, moveY)`.

- **`hold` is synthesized, not received.** The client sends edges only, but `@onEvent(…, { on: 'hold' })` fires
  every tick while held — so a wire `hold` sample updates the axis and dispatches nothing of its own, and the
  pass dispatches `hold` for held buttons **union** non-neutral axes (an axis never enters `held`).
- **`fillIntent` runs here**, ahead of movement's step 4; without it `intent` stays zero and nothing moves.
- **Identity comes from the session**, never the frame; dispatch targets `playerKey(player.id)` and the
  avatar's entity host (absent for a spectator, whose `player.avatar` throws).
- **Interactions drain here too**, after the action edges, so a press that opened a menu and a press on that
  menu's button arriving in one batch resolve in the order the player made them. Dispatch goes through core's
  `pressWidget` / `pointerHit`, never a second copy: the screen-scoping rule for a press and the liveness check
  for a pointer hit are the same on both endpoints. The entity a hit names is the peer's claim — it was
  resolved against a camera the authority does not hold — so it is checked for liveness and nothing more, and a
  handler that grants something must check reach itself.
- **Requests drain here too**, after the interactions and through core's `deliverRequest`, which dispatches
  `@onRequest` at server-located handlers alone. This is the authority half of the security model: a client's
  `request()` crosses the wire precisely so the check runs here, `ctx.player` comes from the session rather
  than the frame, and `ctx.data` is the one untrusted payload a handler is handed.
- **Stale-hold backstop:** after `holdStaleTicks(simRate)` with no traffic, every held action is released and
  every axis returned to neutral — the crash / killed tab / yanked cable a client blur handler cannot cover.
  **Any** well-formed frame counts as traffic, because edges-only input means a player holding one button sends
  nothing; `TimeSync` is the only thing a live client sends unprompted, so it is what liveness means.

### 5.3 Admission

In order, per frame: a **seq sanity bound** — above the frontier, and within `maxSeqGap` of `highestSeen`,
refused before the gap-dating map can be made to cost O(seq). At or below the frontier the seq is already
resolved, so no ack could report it and applying it would re-fire an edge the loop has walked past: a replay,
or a late arrival `abandonStale` gave up on. Then the **tick window** `[tick − pastGrace, tick + futureHorizon]`,
where inside-grace is buffered and merge-forwarded, up to `HORIZON_CLAMP_TICKS` past the horizon is **clamped**
to the horizon, and further out is `too-far-future`; then the **token bucket** (`INPUT_BUCKET_FRAMES` deep, one
token refilled per stepped tick — the wire's own one-frame-per-tick ceiling, with depth for a multi-tick catch-
up's burst). Identity needs no check here: no frame field names a player. A refusal is reported by the ack
advancing past it — there is no `InputNack`. `RATE_BREACH_CLOSE` cumulative rate refusals close that session
alone.

Those three bound how **many** frames arrive; three more bound what **one** frame may contain, since none of
the above sees a frame's shape — the host refuses a frame over `MAX_FRAME_BYTES` before parsing it, but byte
size says nothing about how much per-tick work the contents buy. The narrowing caps `actions[]` at
`MAX_ACTIONS_PER_FRAME` and each name at `MAX_ACTION_NAME_LENGTH`, and admission caps the distinct names a
session may open at `MAX_ACTION_NAMES` — a held name buys a synthesized `hold` dispatch every tick for as long
as it is held, so an unbounded key space is unbounded per-tick work bought with one frame. An axis `value` must
also be **finite**: it reaches `fillIntent` unmodified and core writes it straight into a `Float64Array`, so
one `Infinity` poisons the world permanently. A frame failing any of these is dropped whole and unresolved, so
its seq stalls the ack like a frame that never arrived until `abandonStale` releases it.

`join-request` and `time-sync` draw on a **second, far shallower bucket** (`CONTROL_BUCKET_FRAMES`, one token
per `CONTROL_REFILL_MS`) that the input bucket does not cover: a resync buys a full world walk and a
`time-sync` buys a reply, and nothing else rate-limits either. `interaction` draws on the **input** bucket
instead — it is the same shape of cost as an input frame, one per tick with bounded contents, and one bucket is
what keeps a peer's _total_ per-tick work bounded rather than letting a second channel double it. Its narrowing
caps `events[]` at `MAX_INTERACTIONS_PER_FRAME` and each widget or screen name at `MAX_WIDGET_NAME_LENGTH`;
there is no distinct-name cap, because a press buys one dispatch and is gone, where a held action buys one
every tick until it is released. `request` draws on the input bucket for the same reason, and its narrowing
caps `requests[]` at `MAX_REQUESTS_PER_FRAME`, each name at `MAX_REQUEST_NAME_LENGTH`, and the payload at
`MAX_REQUEST_PAYLOAD_NODES` values over the whole graph, which bounds nesting and cardinality together because
depth can never exceed the node count. The walk is iterative, like the codec's, since a well-formed payload a
few thousand deep is small enough to pass every byte cap and would overflow a recursive one before any cap read
it.

Two more bounds, on state a frame is not needed to open: `joinDeadlineTicks` — swept every tick against
`rt.tick − session.openedAtTick`, so it bounds a session's AGE before it joins rather than its silence — and
`MAX_UNJOINED_CONNECTIONS`, **distinct** from `maxPlayers` so unjoined
sockets cannot lock out real players. That cap is a total, so opening adds a per-peer one in the only currency
this package has: a second unjoined session under an `identity` an unjoined session already holds is refused,
since otherwise one named peer reconnect-looping fills every slot at no cost to itself. Bounding an _anonymous_
flood is the host's, which is the only layer that knows an address. Input before the join is dropped — there is
no player to attribute it to.

**The join deadline is counted in ticks**, like every other window here, because the sim reads no clock. A
world falling behind therefore stretches the deadline rather than evicting its joiners: the host's shed is
already the visible slowdown, and adding a wave of closes to it makes a slow session an empty one.

Every window and cap constant is stated in **milliseconds** and converted per `simRate`: a tick count sized for
60 Hz is three times the wall-clock window at 20 Hz.

### 5.4 `ackSeq` is the highest contiguous **resolved** seq

Resolved = applied **or** definitively rejected. So a refusal advances the ack past itself (nothing stalls in
the client's ring), while a **gap holds it back** (the client still owes that seq a replay). A frame buffered
for a future tick resolves at the apply, not at arrival — acking it early would let the client prune input it
needs. `AdmissionState` keeps the frontier, the resolved-above-frontier set, and per-seq `headroom`
(`frame.tick − serverTickOnArrival`, already computed for the window check); `takeAck()` walks the frontier
forward and reports `earliestHeadroom` for the earliest input that ack resolved — **absent**, never
`undefined`, on a quiet tick. A seq that never arrived is datable (`seq` and `tick` advance together), so
`abandonStale` releases it once its latest possible tick falls out of the past grace. That same arithmetic
sizes `maxSeqGap` to the window rather than to a round number: a seq further ahead than the window is wide
names a tick nothing could apply, so admitting it would only buy the gap-dating walk.

---

## 6. Stepping and the drain

### 6.1 One tick, and a drain when the batch says so

Per tick, in order: open the batch's connections → release the ones it acknowledges saved → seed the records it
answers → narrow and admit its frames → release the connections it reports closed → refill each session's
tokens → `Loop.step(rt.tick + 1)` → `abandonStale` → sweep the join deadline → and, on a `drain` tick,
`drainOnce`, the fan-out, and the pending joins.

**The `Welcome` is built at the drain, immediately after it** — a snapshot taken at `JoinRequest` time sits on
the wrong side of the journal cut, and the joiner's first envelope would replay ops its snapshot already holds.
A duplicate `spawn` is not idempotent: the client mints a second entity and orphans the first. Cost is one send
interval of join latency. Drains are on the send-tick, not every tick, because core's channels accumulating
between sends _is_ the net-change accumulation.

**Ops held over are the same hazard.** A snapshot reads live state, so it already contains the effect of
everything still in the spill queue — a joiner is therefore stamped with `Session.structuralSkip =
spill.length` when its `Welcome` goes out, and drops that many ops off the front of the envelopes that follow.
Counted down rather than cleared, since a spill deeper than one send's budget spans several sends.

**A `Welcome` over `MAX_FRAME_PAYLOAD_BYTES` is divided** (`chunk.ts`): the snapshot's `entities` and `state`
move into `snapshot-chunk` envelopes queued **before** it, and the `Welcome` carries `snapshotChunks` naming
how many. Measured once against the injected codec, so a world that fits pays one encode and nothing else.
`splitSnapshot` sizes groups by **measuring** each element rather than counting them — `template`, `tags` and a
`@serverState` value are all creator-authored, so element count says little about bytes — and an element no
frame could carry alone is dropped and counted, like an unrepresentable mark. The tick and the roster stay on
the `Welcome`: one is a scalar and the other is bounded by `maxPlayers`.

**The render manifest is live, not captured.** `ManifestStore` holds every visual declared so far, keyed by
name so a re-declaration costs nothing, and queues whatever is genuinely new. `declareVisuals(manifest)` is how
a template comes into use mid-session; the additions go out as a `manifest` envelope **before** the fan-out on
the next drain, because that same send's journal may carry the first spawn of one and a node created against a
table that lacks the template draws the placeholder and keeps it. A session still awaiting its `Welcome` is
skipped, since the snapshot already gives it the whole manifest — so a joiner and an already-connected peer
cannot end up able to draw different things. Assets are defined on core's registry alongside, or `assets.get`
answers `null` for a key the wire is already carrying.

**`TimeSync` is answered at the drain**, not at arrival, so the tick a reply names is one the world has reached
rather than whatever tick the batch found it at. `serverSentMs` is `batch.nowMs`; the client differences only
its own two stamps, so no agreement between the two machines' clocks is needed.

### 6.2 Two envelopes, both tick-stamped

Protocol's types, split by reliability class and joined by an equal `tick`:

- **`StateEnvelope`** (reliable, per session) — `tick`, `ackSeq`, `earliestHeadroom?`, `structural`, `state`.
  Per-connection by construction, so it cannot be encoded once.
- **`TransformEnvelope`** (droppable, shared) — `tick` plus whole-transform diffs; identical for every peer, so
  it is the one `Send` whose `to` names every broadcasting session at once.

### 6.3 The drain: three channels to one `SendSet`

Nothing sits between the drain and the envelope. `drainOnce` runs once per drain tick (each drain clears what
it consumes, so a per-session drain would starve every session but the first) and its `SendSet` lives for
exactly one send — except the spill queue, which is the one thing carried between them.

**The structural budget is the only bound on what the sim produces.** Everything else here bounds what it
_accepts_; nothing limited a journal, so a script spawning in a loop mints an envelope past the frame cap —
refused by every peer before parsing, and the client's answer to a broken session is a resync, which asks for a
full snapshot and is bigger. So `MAX_STRUCTURAL_OPS_PER_SEND` caps one send and the remainder goes to
`Sim.#spill`, at the **front** of the next send's ops and ahead of anything new. Strictly ordered: the ops do
not commute and the journal is applied verbatim, so a reordered spill creates a node for a dead entity — worse
than no cap at all. Ops are converted to wire form **before** they can be held over, because a `spawn`'s
snapshot is read from live state and an entity destroyed while its op waited would go out with an empty
`template`.

- **Roster ops core's journal has no arm for:** `player-join` is **prepended** (it must precede the spawns its
  own handler produced), `player-leave` **appended** (it must follow the destroys of that player's entities).
- **Structural** keeps journal order — order is meaning. `NetId` **is** the `EntityId`, cast at the boundary,
  so no map is needed here. Per op: `spawn` carries a full `EntitySnapshot` with `parent: null, tags: []` and
  no `overrides` (at mark time `create` has set none of the three; each arrives later as its own op) and a
  current transform; `destroy` and `attach` pass through; `reparent` maps `NO_ENTITY` → `null` (core's
  `detach()`); a `say:`-prefixed `tag` is **filtered** (it is not in core's tag index — speech bubbles are
  unreplicated); and a spawn-then-destroy inside one interval is dropped **as a pair**, since a released entity
  has no record and an empty `template` would abort the client's whole reconcile. A `group` converts arm by arm
  and survives whole or not at all, keeps its order, and counts against `MAX_STRUCTURAL_OPS_PER_SEND` by what
  it holds — a group over the budget on its own still goes, alone, because the boundary is indivisible. The
  switch ends in a `never` default: `noImplicitReturns` is off, so an unhandled arm would return `undefined`
  and be counted as unrepresentable rather than caught.
- **The join snapshot restates the attachments** as `EntitySnapshot.overrides.scripts`, read back off the
  instance registry through `rt.scriptIdOf` rather than off the template, because `addScript` puts classes on
  an entity no template names — and those are exactly the ones a joiner cannot infer. A class the resolver
  cannot name is left out, for the reason its `attach` op is never journaled.
- **Transform:** `consumeDirty()` returns dirty slot indices, so each is resolved to an id and the whole
  seven-field transform read in core's order, non-finite cells degraded to slot defaults (`jsonCodec` throws on
  `NaN`, which would abort the send for every peer). A read, never a write.
- **State:** marks are addressed through a table built **forward** from `GAME_KEY`, the roster and `liveIds()`
  using core's own `playerKey`/`entityKey` — a core rename becomes a compile error, and a mark naming a dead
  host misses the table and is counted as `staleMarks`, apart from `droppedMarks` because a write whose host
  dies inside the same send interval is churn rather than a defect. A field is read by one function,
  `encodeHostField`, which `buildSnapshot` calls too, so neither path can keep a field the other discards.
  Values inside it go through `encodeStateValue` (`Entity` → netId, `Player` → id, plain objects/arrays
  recursed, cycle- and depth-guarded); game/entity marks are shared, player marks scoped to their owner, and
  one bucket per host so an address is named once however many fields it wrote. Anything unrepresentable is
  **dropped and counted** (`droppedMarks`) rather than thrown — including a field named `__proto__` /
  `constructor` / `prototype`, transport's `RESERVED_KEYS` rather than a second copy of the set, since the
  grouped shape makes the name a KEY and assigning one would set the bucket's prototype rather than add it —
  checked at **every** level of a value, not only the top, since a serialized wrapper is a nested object and a
  reserved key inside one would set the copy's prototype and ship the field silently short a member. Values are
  read through core's `serializeHostField`, so a wrapper field crosses as its `serialize()` form: read raw it
  is a class instance, which `encodeStateValue` refuses, and every scoreboard write would be dropped and
  counted here.

### 6.4 The fan-out

A walk over the registry that appends to `sends`, reliable envelope first (the client holds a transform
envelope until the state envelope for that tick is applied). The transform envelope is appended once with every
broadcasting session in its `to`, so N sessions still cost the host one `encode`. Most of a state envelope is
per-session (`ackSeq`, `earliestHeadroom`, scoped state), so the transform frame is the whole of the shared
subset. A session awaiting a `Welcome` is skipped by the broadcast and answered by it instead, and
`pendingJoin` is cleared in the same pass — an envelope is only a queued instruction here, so nothing can throw
between the two.

---

## 7. Disconnection and persistence

A session ends on `InputBatch.closed`, on a `CloseOrder` the sim itself raised, or on `close()`. All three run
one path: mark closed, remove from the registry so the next drain skips it, drop its buffered frames, then
release the player — **destroy its owned entities first** (found by scanning `liveIds()` for `record.ownerId`,
never `player.avatar`, which throws for a spectator), then `leavePlayer(rt, id)`, which dispatches
`@onPlayerLeave` at the Game host **before** `PlayerManager.remove`, so the handler can still read the player —
then **capture** that player's host record into `saves`, then queue the `player-leave` op. No grace period and
no reconnect.

The record reference is taken **before** `leavePlayer` and read **after** it — the leave handler may write a
last value, and `PlayerManager.remove` then drops the record from the host table, so neither order alone works.
Only a **host-named** session is captured, and only when the cache holds its record: a connection id is minted
fresh per socket, so a record saved under one is unreadable by anything and a join/leave loop would leak a
durable entry per cycle, while a record the cache does not hold under a host-supplied identity means the read
failed and this session's initializers must not overwrite it.

`SessionRecords` captures synchronously and **keeps** what it captured until the host reports it in
`InputBatch.saved`, so a rejoin under the same host id reads the value back whether or not the store write has
landed — and releasing on the acknowledgement is what stops a long session being sized by every player it ever
saw.

`Sim.close()` is the whole-world form: run that path **inline** for every session rather than waiting for the
host to report each socket closed, which arrives on the next batch — and after a shutdown there is no next
batch, so waiting would leak every `Player` and every registered handler. It returns the batch those leaves
produced, whose `saves` are what a host must drain before it exits. Idempotent: a second call returns an empty
batch. Afterwards `tick` is inert.

---

## 8. Conventions

`NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where type-only, no
cycles. The exported barrel drives core only as values (`loadGame`, `Loop`, `Runtime`) and declares no script,
so nothing on this package's surface carries a decorator. Nothing here imports `node:` anything, which is what
lets the same bundle load in a V8 isolate and in a browser.

Everything this package throws is a `SimError` carrying a `SimErrorCode`, so a host branches on the code rather
than on message text: `invalid-config` and `invalid-argument` are the caller's to fix, `no-pass-table` is a
wiring fault, `sim-closed` is lifecycle misuse. Engine constants live in `constants.ts`, grouped by unit, never
on the creator surface:

| Constant                      | Value                 | Bounds                                                 |
| ----------------------------- | --------------------- | ------------------------------------------------------ |
| `INPUT_WINDOW_MS`             | `MAX_REWIND_MS` (250) | both sides of the tick window                          |
| `JOIN_DEADLINE_MS`            | 5 000                 | silence before an unjoined session is closed           |
| `HOLD_STALE_MS`               | 5 000                 | silence before held actions are released               |
| `INPUT_BUCKET_FRAMES`         | 8                     | input-frame token depth, one refilled per stepped tick |
| `RATE_BREACH_CLOSE`           | 64                    | cumulative rate refusals before the session closes     |
| `CONTROL_BUCKET_FRAMES`       | 4                     | `join-request` + `time-sync` token depth               |
| `CONTROL_REFILL_MS`           | 1 000                 | wall-clock per control token                           |
| `MAX_ACTIONS_PER_FRAME`       | 32                    | actions one input frame may carry                      |
| `MAX_ACTION_NAME_LENGTH`      | 64                    | longest accepted action name                           |
| `MAX_ACTION_NAMES`            | 64                    | distinct action names one session may open             |
| `MAX_INTERACTIONS_PER_FRAME`  | 16                    | interactions one frame may carry                       |
| `MAX_WIDGET_NAME_LENGTH`      | 64                    | longest accepted widget or screen name                 |
| `MAX_REQUESTS_PER_FRAME`      | 16                    | requests one frame may carry                           |
| `MAX_REQUEST_NAME_LENGTH`     | 64                    | longest accepted request name                          |
| `MAX_REQUEST_PAYLOAD_NODES`   | 256                   | values one request payload may hold, whole graph       |
| `MAX_NAME_LENGTH`             | 24                    | longest accepted display name, in code points          |
| `MAX_IDENTITY_LENGTH`         | 128                   | longest accepted `projectId` / hash on a join request  |
| `MAX_STATE_DEPTH`             | 64                    | `@serverState` nesting past which a value is dropped   |
| `MAX_UNJOINED_CONNECTIONS`    | 32                    | unjoined sessions held at once                         |
| `HORIZON_CLAMP_TICKS`         | 2                     | ticks past the horizon clamped rather than refused     |
| `MAX_STRUCTURAL_OPS_PER_SEND` | 2 048                 | structural ops one send carries; the rest spill        |
| `MAX_FRAME_PAYLOAD_BYTES`     | ¾ `MAX_FRAME_BYTES`   | bytes a sim-minted frame targets, under the cap        |

`pastGraceTicks` / `futureHorizonTicks` / `holdStaleTicks` / `controlRefillTicks` / `joinDeadlineTicks` convert
these to ticks of the session's own rate, and `maxSeqGap` composes the first two with `HORIZON_CLAMP_TICKS`
rather than naming a bound of its own. `MAX_STATE_DEPTH` is the one that is not a policy choice: it must stay
far below the codec's own 128-level cap, which the envelope's own nesting eats into, because a value the
encoder passes and the codec refuses throws out of the fan-out.

The catch-up budget and the send cadence are **not here**: they are the host's clock policy, stated in
`packages/glue/src/server/driver.ts` and in `apps/grove/host/src/clock.rs`.

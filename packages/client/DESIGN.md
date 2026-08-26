# `@platform/client` — internals

**TLDR.** The viewer, and the only package that owns a clock. It holds one `Transport` to the server, a
**`@platform/core` runtime** it writes by applying server envelopes and by replaying its own unacked input
over them, device input stamped with a tick, and the display loop that pushes transforms into `IRenderer`.
It is `@platform/server`'s wire peer — they agree through `@platform/protocol` and never import each other.
It has **no authority**: what it simulates is provisional, scoped to the entities the local player owns, and
rewound to the authoritative pose before the next delta lands.

```
server ──state/transform envelopes──> Transport ──> Mirror (core runtime) <──replay── InputRing
                                          │                    │
       <──── input frames (one per tick) ──┘                    └──> RenderBridge ──> IRenderer
```

Deps: `core`, `math`, `protocol`, `renderer`, `transport`. Never `server`. No React.

## Layout

| File                                   | Owns                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| [src/client.ts](src/client.ts)         | `GameClient` — frame order, receive/dispatch, input flush, liveness, resync           |
| [src/mirror.ts](src/mirror.ts)         | `Mirror` — the runtime, the paths that write it from the wire, its pass table         |
| [src/prediction.ts](src/prediction.ts) | `Prediction` — baseline, rewind, replay, scope, correction                            |
| [src/passes.ts](src/passes.ts)         | The client's `TickPasses`: the input fold, and the scope the rest honour              |
| [src/index-map.ts](src/index-map.ts)   | `MirrorIndex` — bidirectional `netId ↔ EntityId`                                      |
| [src/clock.ts](src/clock.ts)           | `ClientClock` — tick accumulator, lead loop, nudge, epoch, behind-check               |
| [src/ring.ts](src/ring.ts)             | `InputRing` — unacked frames, fold-at-prune horizon                                   |
| [src/bindings.ts](src/bindings.ts)     | `BindingTable` — raw event → action edges, axis quantizer, held codes                 |
| [src/input.ts](src/input.ts)           | Seams: `RawInputEvent`, `InputDevice`, `FrameSource` + scripted implementations       |
| [src/handshake.ts](src/handshake.ts)   | Join/time-sync builders, envelope narrowing, welcome validation, reject text          |
| [src/bundle.ts](src/bundle.ts)         | `BundleSource` seam, and the fetch → bound → hash → compare → evaluate order          |
| [src/lifecycle.ts](src/lifecycle.ts)   | `Lifecycle` — `SessionState`, `FailureReason`, input gating                           |
| [src/bridge.ts](src/bridge.ts)         | `RenderBridge` — `EntityId → NodeId`, manifest, dirty-set push, interpolation, camera |
| [src/hud-sink.ts](src/hud-sink.ts)     | `ClientHUDSink` — core's HUD seam: widget records and the open screen stack           |
| [src/constants.ts](src/constants.ts)   | Engine constants, each stating its unit                                               |
| [src/browser/](src/browser/)           | DOM adapters behind the `./browser` subpath                                           |

Two exports: `.` (no DOM) and `./browser` (`createRafFrameSource`, `createPerformanceClock`,
`createDomInputDevice`, `pollGamepads`, `createBrowserBundleSource`). `tsconfig.json` adds `lib: DOM` package-wide, since a project
reference cannot cover one subdirectory; the boundary is held by a `no-restricted-globals` override in
`.oxlintrc.json` denying `window`/`document`/`navigator`/`performance`/rAF outside `src/browser/`.

## The frame ([src/client.ts](src/client.ts))

`GameClient.frame(nowSeconds)` is the whole loop body; what calls it is injected (`FrameSource`), so a
browser passes rAF and a headless host drives it by hand.

1. `pump?.()` — loopback `deliver()`; a real socket has already delivered.
2. Drain the inbox **in arrival order**, one `apply` per envelope. A batch holding a `state` or `transform`
   envelope **rewinds the predicted world once, ahead of the batch** — a delta names only what changed, so
   a field it does not mention would keep its predicted value and never converge. Deltas are consumed in
   arrival order too; a set-union would create a node for a dead entity. Each dispatch is wrapped: an
   envelope that throws deeper than `asServerEnvelope` reaches fails the session as `peer`, because an
   exception escaping here unwinds through the frame source and ends the session with no state to show a
   person. While a bundle is in flight the drain **holds** instead: it returns before splicing, and a
   `Welcome` that opens a fetch mid-batch pushes the rest of that batch back onto the FRONT of the inbox, so
   arrival order survives the wait and nothing is dropped into a session that does not exist yet.
3. `clock.advance(now)` → 0..N tick indices (dt clamped inside), then flush one input frame per tick.
4. `#predict()` — carry the predicted world to `localTick`. After the flush, so the tick just stamped is
   replayed on the frame it was sent; only while `live`.
5. `#checkBundleDeadline()` → `bundle` failure; `#checkNotBehind()` → resync; `#checkLiveness()` → `stalled`
   in **both** directions; `#maybeSync()`.
6. `bridge.pushTransforms(now)`, `bridge.pushCamera()`, `renderer.render()`.

The push is after tick advance, not inside it: a frame that advanced three ticks still pushes once.
`start()` registers handlers _before_ sending the `JoinRequest`, so ordering never depends on transport
retention. `destroy()` is ordered reverse of setup and idempotent; it destroys the renderer only when
`ownsRenderer` is passed, and clears core's module-global runtime **only if that slot still holds its own**.

`#now` is always the **frame source's** seconds. The injected `ClockSource` is read only to stamp the join
and each `TimeSync`, so the two time bases never meet in one subtraction.

## Handshake ([src/handshake.ts](src/handshake.ts))

The client speaks first: `JoinRequest { protocolVersion, name, clientSentMs, projectId, projectHash,
bundleHash, token? }`. The three identity fields are the client's claim about what it is running, built from
`GameClientOptions.project` with `bundleHash` overridden by whatever this process has actually verified — so
a resync after a load declares the newer bundle and a server that has moved on refuses. `Welcome` supplies
`simRate`, `sendRate` (the interval the render path interpolates over), `yourPlayerId`, `bounds`, `regions`,
`visuals`, the server's own identity plus `bundleUrl`, and `snapshot` (whose `tick` seeds the clock).
`isUsableWelcome` structurally validates **every
field the join path dereferences** before trusting it — including `bounds`, `regions`, `visuals`,
`snapshot.state` and the four identity strings, which are read unguarded — and
a `Welcome` that fails it is terminal and distinct from a `Reject`. `rttSeconds` differences **the stamp the
client recorded at send**, never the value the server echoed back, which is peer-controlled; a `TimeSync`
reply whose echo does not match the outstanding stamp is not ours and is dropped. `serverSentMs` is
observability. `asServerEnvelope` narrows on an exhaustive `kind` switch, never sniffing, and additionally
checks the depth-one fields the client walks without guarding — a `state` envelope whose `structural` is
absent is dropped at the boundary rather than throwing inside the mirror. Every array it will walk is
also bounded at `MAX_WIRE_ITEMS` before the walk, since the count is peer-chosen and the work is linear
in it. `TimeSync` refreshes every
`SYNC_INTERVAL_SECONDS` and is diagnostic after the seed.

**A snapshot arriving in pieces is reassembled here, not in the mirror.** `snapshot-chunk` envelopes precede
their `Welcome`, which names how many there were; `GameClient` holds them — bounded at
`MAX_SNAPSHOT_CHUNKS`, because they are memory kept before anything has been validated — and folds them onto
`snapshot.entities` / `snapshot.state` **ahead** of the welcome's own remainder, since `entities` is
parents-before-children across the whole set. The fold runs before `isUsableWelcome`, so every path below it
sees one whole world and chunking is invisible past that line. A set that does not match the count fails the
session as `peer`: a world missing entities the server believes it sent reads later as a mirror bug rather
than as the truncated join it is. A chunk arriving for a join already answered is dropped and counted, and a
resync discards what it held — the next join answers with its own set, at its own tick.

## The bundle ([src/bundle.ts](src/bundle.ts))

A `Welcome` naming a `bundleUrl` is answered by **fetch → bound → hash → compare → evaluate**, and the order
is the mechanism: a bundle is executable, so evaluating before comparing would be running the peer's code to
decide whether to run the peer's code. `BundleSource` is three primitives rather than one `load(url, hash)`
precisely so the comparison stays here — a host handed the whole job could skip it and nothing would know.
The url is scheme-checked with the renderer's `isAllowedAssetUrl` against `REMOTE_ASSET_SCHEMES`, the same
policy `WireAssetRef.url` gets, and unlike an asset a refusal **fails the session**: there is no placeholder
for missing code. The bytes are bounded at `MAX_BUNDLE_BYTES` before the digest, and `evaluate` is handed the
bytes that were hashed, never the url again — a second fetch is a second answer.

The session therefore has a pre-`live` state. `#onWelcome` measures the RTT **before** branching, since the
lead seeds from it and folding a download into it would size the lead to the download; then it either opens
the session at once (`bundleUrl === ''`, or this process already holds that hash) or enters `loading`.
A missing `GameClientOptions.bundle` against a server that names one is a `bundle` failure, never a silent
skip. `BUNDLE_DEADLINE_SECONDS` bounds the wait and, with it, the held inbox. The verified hash **survives a
resync** — the code is in this process — while any in-flight load does not, since its welcome will never be
answered.

## The mirror ([src/mirror.ts](src/mirror.ts))

`loadGame({ role: 'client' })`, then `rt.passes` is replaced with no-ops; no `startGame`. `simulate(ctx)`
is the **one writer of `rt.passes` after construction** — it installs the client's table over the one
`loadGame` built, and `simulate(null)` puts the no-ops back, so an idle mirror handed a `step` moves nothing.

`depictedTick` is its **own field**, not `rt.tick`: a prediction step assigns `rt.tick` the local tick, and
the two agree only while nothing is predicted. `rt.tick` is what the simulated world believes the time is;
`depictedTick` is what the wire last said it was, and it is the term `isBehind` tests — the only sound
statement is `localTick >= depictedTick`.

Three wire write paths, and outside them only a prediction step:

- `applyState(env)` → `MirrorDelta { added, removed, reparented, joined, left }` (**ordered lists, not
  sets**). Order: structural in journal order → `drainDestroyed()` + unmap once → `@serverState` diffs →
  `channels.clear()` → release any held transform envelope.
- `applyTransforms(env)` — **held** until the `StateEnvelope` of the same tick has landed; a superseded
  held envelope is dropped and counted, since transform is droppable by construction.
- `applySnapshot(welcome)` — the join snapshot replayed as `player-join` + `spawn` ops through
  `applyState`. Applied to a non-empty mirror this _is_ a resync. `reset()` empties the world for one.

Structural ops: `spawn`/`enter-interest` share one applier over `EntitySnapshot` (template, owner, parent,
tags, all transform fields — a static entity is dirty exactly once, so `spawn`'s position-only write would
strand scale/layer — then `overrides.scripts`, the baseline for the `attach` ops a joiner was not there for);
`destroy`/`leave-interest`; `reparent` (**also reported on the delta**, since the
render tree cannot infer it); `tag`; `player-join` (mints a `Player` and `playerManager.adopt`s it, keeping
the **wire's** index); `player-leave`; `attach`, resolved through the script registry; and `group`, whose
ops are applied verbatim and in order like the outer journal, bounded at `MAX_WIRE_ITEMS` before the walk.
The switch ends in a `never` default, because `noImplicitReturns` is off and an unhandled arm would no-op
in silence.

**One registry, keyed one way.** `GameClientOptions.scripts` is a `ScriptIndex` — `resolve(ScriptId)` and
`locationOf(ScriptId)`, declared structurally so `@platform/scripting`'s `ScriptRegistry` satisfies it
without this package depending on it. Both the `attach` op and a spawn's overrides name a `ScriptId`, so
nothing here is keyed by template or by class name, which a minifier rewrites. A `ServerScript` is skipped
rather than counted — the authority runs it and a client tick filters it out of every dispatch — while an
id this bundle holds no class for is counted (`droppedAttach`), which is what the handshake's `projectHash`
exists to keep at zero.

`@serverState` arrives as one `StateDiff` per host carrying a `fields` bag, and lands in
`hosts.ensure(key).record` through core's `restoreHostField` — one `StateDiff` per host, its `fields` map
walked with `Object.entries` — keyed with core's own `GAME_KEY` /
`playerKey` / `entityKey` helpers — with no scripts there is no hoisted accessor, and the record is the one a
hoist would land on. `restoreHostField` rather than a bare `set`, because a wrapper field's value is a
wrapper: one already on the record is `restore()`d in place, since a script may hold that same instance, and
one the client does not have is revived from the payload's own tag — a `Scoreboard` arrives with its methods,
not as a decoded blob. `channels.clear()` discards structural and state marks (no consumer here) but
provably **not** the transform dirty set, which is the render bridge's work queue. Unknown `netId`s,
out-of-order parents, and a spawn whose `netId` is not a plausible server handle (not a non-negative safe
integer) are dropped/rooted and **counted** (`MirrorCounters`), never thrown. `#spawn` is the only place a
peer-chosen `netId` enters the map, so it is the only place that has to check.

## Prediction ([src/prediction.ts](src/prediction.ts), [src/passes.ts](src/passes.ts))

Off unless `GameClient` is given `predict`. What it runs is the creator scripts attached to the local
player's entities, so a mirror holding none predicts an unchanged world at the cost of the replay. Those
arrive as `attach` ops and as a spawn's `overrides`, resolved through `scripts`; a predicting client that
supplies no registry attaches nothing and therefore simulates nothing.

The mirror holds the predicted world — the render path needs no second source — and `Prediction` holds the
**authoritative baseline** it rewinds to. The cycle is `rewind → apply → capture → replay`, and its order is
the whole correctness argument: a delta lands on authoritative state, never on a predicted pose.

- **Rewind** restores the registered stores through `Loop.restore`, which also resets `rt.tick` and kills
  invocations newer than the baseline, then restores `@serverState` and **re-marks the rewound slots
  dirty** — a store's `apply` writes the transform arrays without marking anything, and the dirty set is
  the bridge's whole work queue. Idempotent within a batch: once the predicted world is gone there is
  nothing to take back.
- **Capture** refills caller-owned buffers rather than calling `Loop.snapshot`, which mints one per store
  per call — one of them seven typed arrays sized to the entity count, at send rate. `@serverState` rides
  alongside it, cleared and refilled per host rather than merged, because a field a predicted tick added is
  absent from the buffer and a merge would leave it; the record object itself survives, since a script
  attached later hoists its accessors onto that identity.
- **Replay** re-runs `depictedTick+1 … localTick`, with `replay: true` on every tick at or below the
  highest already simulated — the flag suppresses client-located handlers, so a one-shot client effect
  fires on a tick's first simulation and not on its re-runs. Bounded by `MAX_REPLAY_TICKS`; past it the
  span starts at the cap and the skip is counted.
- Between envelopes there is no rewind: the world is carried forward onto the ticks the clock just
  produced. Re-running settled ticks every frame would fire each synced handler's effects again.

**Scope is ownership.** `EntityRecord.ownerId` is the only field naming a player, and nothing here fills a
`Player`'s avatar — so the entities this client simulates are the ones it owns, refreshed whenever
authoritative state lands. The scope narrows the snapshot, the movement pass and `@onUpdate`; core's own
table ignores the `scope` a step hands it, so [src/passes.ts](src/passes.ts) is where the narrowing happens
or a remote avatar is extrapolated off input this client never had.

**The input pass is the server's, restated.** It cannot be imported — the client never imports the server —
and its order is the contract: one `advanceTick` before any edge lands, then the tick's edges, then one
synthesized `hold` per held button **union** non-neutral axis, then `fillIntent` ahead of the movement pass.
A sampled `hold` in a frame updates the axis and dispatches nothing; the synthesized one is the only `hold`.
The fold is seeded from `InputRing.heldAtHorizon` and then walked forward over every frame the authority has
already simulated, because the horizon is an interval and not a tick. `contacts` and `regions` are both
dropped outright: each is a consequence of a position this client only predicted, and consequences are the
authority's — and each diffs against a previous tick no snapshot store holds, so a rewind would leave the
edge describing a tick that was taken back. `countdowns` stays core's, because a countdown is host-local
display timing with no authoritative counterpart, and core's own pass already skips a replayed tick.
`starts` stays core's too: a script the wire told this client to attach is owed its `@onStart` on the same
pass the authority ran it, and the drain is once-only, so a replayed tick cannot spend it twice.

## HUD ([src/hud-sink.ts](src/hud-sink.ts))

`ClientHUDSink` is core's `HUDSink`, installed on the mirror's runtime **before** the join snapshot is
applied — a script attached during it may write a widget on the way up, and core's null sink would drop that
write in silence. It holds one record per widget under its name and the open screen stack bottom to top, and
notifies subscribers; each pushed record is copied so a reader holds a value core's next write cannot change
under it, and shallowly, which keeps a bound `Countdown` the live object a timer widget needs. A listener's
throw is contained, so a UI bug cannot unwind into the handler that wrote the widget. A resync clears it: the
HUD belongs to the world being discarded.

`GameClient.pressWidget(widget, screen?)` and `.pointer(edge, local)` are the two ways in. Each dispatches
locally **unconditionally** — hover, press animation, selection and disabled styling are client state and
must not go dead because the session stalled — and queues an `interaction` event for the authority only while
input is accepted, since a press the server would refuse as stale is worse than one never sent. The queue
flushes once per frame as one `InteractionFrame` stamped with `localTick`; it never enters `InputRing`,
because an interaction carries no `seq`, is not acked and is not replayed. `pointer` takes the **local**
`EntityId` and maps it to a `netId` here, so the layer that hit-tests never learns there is a network.

**A correction is eased on screen and exact in the simulation.** What the authority disagreed with is
measured across the rewind — from the **drawn** pose, not the simulated one, because the offset replaces
rather than accumulates and a measurement blind to the ease still in flight would discard it, jumping the
drawn position by the residual once per envelope. It is handed to `RenderBridge` as a decaying offset, in
world units, applied where a drawn position is computed and nowhere else. Past
`CORRECTION_SNAP_DISTANCE_SQUARED` it is shown at once, since easing a teleport draws a slide the simulation
never made. The scope is handed to `RenderBridge` live, because it is also the exclusion list for the
interpolation buffer: an entity is either predicted or interpolated, never both. `GameClient` resolves the
follow camera through the bridge's drawn pose, or the avatar slides across the screen on every correction.

## The clock ([src/clock.ts](src/clock.ts))

Two rates off one injected `ClockSource`: display (rAF) and tick (`simRate`). Seed:
`localTick = snapshot.tick + ceil(clampLead(rtt) * simRate)` — one **unhalved** RTT (downlink + uplink).
The lead is stored in **seconds** and converted on demand, because it covers a duration and `simRate` is
panel-authored at 20/30/60.

Closed loop on server-measured headroom (`StateEnvelope.earliestHeadroom`, describing the earliest input
the ack resolved):

```
undelivered       = targetLeadTicks - entry.leadAtSendTicks   // measured AT SEND: anti-windup
effectiveHeadroom = headroom + undelivered
target            = clampLead(target + GAIN * (HEADROOM_TARGET - effectiveHeadroom) / simRate)
```

`currentLeadSeconds` is **bookkeeping, never measured** — it moves only by the time the nudge inserted or
removed. The nudge is the sole actuator and changes only the tick _duration_ (±`NUDGE_MAX`, deadband half a
tick), so **every tick index is stamped exactly once, in order**. `isBehind(depictedTick)` is a sign test,
latency-independent, and is what catches a suspended tab. A non-finite `now` is discarded, not stored;
backwards clocks are inert. `epoch` is bumped on stall and resync so post-stall headroom samples are
discarded by the epoch of the **acked ring entry**, not by arrival time.

## Input ([src/bindings.ts](src/bindings.ts), [src/ring.ts](src/ring.ts))

Edges only, plus an axis sample when it moves past a quantum; **one frame per tick** carrying every action
for that tick, coalesced per `(action, phase)`, empty frames unsent — so `seq` and `tick` advance together
and `ackSeq` names a tick boundary. `BindingTable` is per player, context-filtered, pure, and tracks held
codes; a key bound as an axis half goes through the axis path via `polarity`. Cursor axes quantize against
`AXIS_QUANTUM * viewport extent`, so wire volume is zoom-invariant; a return to neutral always sends. The
context-filtered view is cached and invalidated by `setContext`/`add`/`rebind`, because `resolve` runs per
raw event and a pointer move would otherwise allocate a filtered array twice per event. `rebind` replaces
an action's **button** bindings only, so rebinding keys keeps the gamepad axis driving the same action.

`focusLost` yields a release per held code, **flushed immediately** (a hidden tab stops being driven) and
**exempt from the `stalled` refusal** (a release can only end ghost gameplay).

When input **resumes** after being refused, what the wire believes is stale: nothing was sent while it was
refused, so `forgetSentValues()` clears the quantizer and every non-neutral axis is re-asserted — a `hold`
is idempotent. A **press** is re-asserted only after a re-join, where the server's session is new and holds
nothing; after a stall the same session still holds it and a second press would dispatch a spurious edge.
The held-code set survives both, because it is device truth: clearing it would swallow the release edge for
every key held across the transition.

`InputRing` holds `RING_TICKS` entries of `{ frame, leadAtSendTicks, epoch }`. `ack(seq)` prunes everything
**resolved** (applied _or_ refused) and returns the **earliest** pruned entry — the one the headroom sample
describes. Each pruned frame folds through core's `ActionStates.applyEdge` into `heldAtHorizon`, which is
what makes edges-only replay-sufficient; the guarantee is an **interval**,
`[horizonTick, horizonValidUntil)`, not an equality. Overflow drops the oldest and counts; it is
deliberately not a lifecycle trigger. `reset(live)` rebuilds the horizon from live action state on resync.

## Render ([src/bridge.ts](src/bridge.ts))

`RenderBridge` holds a read-only `MirrorView`, so the per-frame layer cannot reach `setPosition`. The node
map keys on the **local `EntityId`**, so the render layer never learns there is a network.

- `loadManifest` splits the welcome's `RenderManifest`: assets to `renderer.loadAssets` (`texture`→`image`,
  `atlas`/`font` through, `audio`/`clip`/`effect` skipped), templates into the `template → NodeDesc` table.
  A `url` is **parsed and scheme-checked** first, by the renderer's own `isAllowedAssetUrl` against its
  `REMOTE_ASSET_SCHEMES` — `http:`, `https:` or relative only, narrower than what the loader accepts, and one
  parser so the two cannot disagree — because it is the one wire field that makes the client fetch an address
  the server chose; a refused entry is skipped, not fatal.
  The template half fills **before the first `await`**, so the caller may start it and reconcile the join
  snapshot without waiting. A rejection is counted (`ClientStats.assetLoadFailed`), never left unhandled.
  The merge is **additive**: the welcome's manifest is a baseline, and a `manifest` envelope carries the
  templates that came into use since — so replacing the table would drop everything the join established.
  The same before-the-`await` rule carries the additive case, since the spawn using a new template rides the
  envelope directly behind it. Asset names dedupe through the renderer's own `AssetQueue`, not a second table
  here, so "already declared" has one answer and a re-declared entry is not re-fetched.
  A group template's `children` is flattened **here, once** into a `createSubtree` batch — the recursive
  wire shape is walked at join, never per spawn — bounded by `MAX_WIRE_ITEMS` per level, `MAX_TEMPLATE_DEPTH`
  and `MAX_TEMPLATE_NODES`, since one per-level cap raised to the nesting is not a bound. A list that
  exceeds any of them, or that names a sprite with no texture, refuses the **whole** template.
- A group template with `children` spawns as ONE `createSubtree` call whose root carries the entity's
  transform; the descendants belong to the renderer's tree alone, so `destroyNode`'s cascade, the store's
  position composition and the O(dirty) cull pass reach them with no per-descendant bookkeeping here.
- `reconcile(delta)` creates, **reparents**, then destroys from the ordered delta, never by diffing the
  world. Destroy collects **all descendants by ancestry** out of the map, since `destroyNode` cascades the
  subtree; the ancestry comes from the bridge's own `parent`/`children` index, which is also what makes a
  destroy cost the subtree rather than one renderer `parentOf` call per node per level.
- `pushTransforms` drains `consumeDirty()` — **slot indices**, resolved via `idAt`, released slots read as
  `NO_ENTITY` and are skipped — into one batched `updateNodes`, together with whatever is still easing or
  still being interpolated.
- **An entity is either predicted or interpolated, never both.** Everything outside prediction's scope is
  drawn `1 / Welcome.sendRate` seconds behind the newest transform and walked between the two samples either
  side of that moment — without it the send rate _is_ that entity's visible motion rate, since a transform
  only changes when an envelope lands. The delay is capped at `MAX_INTERPOLATION_DELAY_SECONDS` because
  `sendRate` is the server's to choose. Samples are taken in the push, from the dirty set, stamped with the
  frame source's seconds — the same base the correction decays on, and the only one this package draws in.
  Feeding a predicted entity through as well would give it two smoothers, which reads as rubber-banding.
- **A sample that does not arrive holds; it never extrapolates.** Past the newest sample the drawn pose
  clamps there, because an entity that stopped and an entity nobody sent for are indistinguishable here, and
  carrying the last segment's velocity on would draw a pose nobody simulated every time anything stopped.
  Opening a segment re-stamps its near end to the drawn moment when the drawn pose had already reached it,
  or an entity that stood still for a second crosses almost all of its next segment on one frame.
  Position, rotation, scale and alpha interpolate; rotation the short way round, since the authority may
  wrap it. `layer` takes the newer sample whole — a fraction of a draw order is not a draw order.
- **Structural ops are never delayed.** Only transforms buffer: a spawn or destroy held back by a send
  interval would let a destroyed entity draw for another frame. The buffer is dropped in `clear()`, so a
  resync cannot interpolate between two worlds. `drawnPosition` answers where an entity is on screen down
  either path, which is what the follow camera resolves through.
- A missing or empty template draws `'__missing__'`, a name the renderer cannot reject, so one placeholder
  appears instead of the whole reconcile aborting.
- `pushCamera` sets the camera **every frame, unconditionally**; `viewport` reports world extent for the
  cursor quantum. `GameClient` resolves the local player's core `Camera` (follow target → live position)
  unless a `camera` resolver is supplied.

## Lifecycle ([src/lifecycle.ts](src/lifecycle.ts))

| State          | Entered when                                                      | Input |
| -------------- | ----------------------------------------------------------------- | ----- |
| `connecting`   | `JoinRequest` sent, no `Welcome` yet                              | no    |
| `loading`      | `Welcome` accepted, its bundle still fetching                     | no    |
| `live`         | `Welcome` applied, clock seeded                                   | yes   |
| `stalled`      | no envelope for `STALL_SECONDS`, **or** `ackSeq` frozen           | no    |
| `resyncing`    | `localTick < depictedTick`, or a `RateChange`                     | no    |
| `disconnected` | `onClose` fired                                                   | no    |
| `failed`       | `Reject`, unusable `Welcome`, a bad bundle, or a `TransportError` | no    |

`failed` is terminal and absorbs later transitions. `FailureReason` distinguishes `rejected` (with phrased
reason + `serverProtocolVersion`), `undecodable`, `internal` (`encode-rejected` — our bug), `peer`
(a malformed or hostile frame, including an envelope that threw while applying) and `bundle` (code that would
not load, or was not the code the server said it would be). `loading` refuses input for the reason `stalled`
does not cover: there is no session yet, so there is nothing for a tick to be stamped against. Both stall triggers are
evidence about the _connection_; ring occupancy deliberately is not, or an energetic player could disable
their own controls. `RateChange` resyncs rather than retuning, because core does not retune pending timers,
the lag ring, or already-stamped input frames. A listener's throw is contained, so a UI bug cannot unwind
into the frame that changed state.

## Constants ([src/constants.ts](src/constants.ts))

Each constant states its unit in its own doc line, because mixing them is the failure mode (a tick is
16.7 ms at 60 Hz, 50 ms at 20 Hz) and the unit is wanted where the reader hovers it, not in a divider.

| Ticks                                    | Seconds                                                                                                                                                            | Dimensionless                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `HEADROOM_TARGET` 2 · `LEAD_MIN_TICKS` 1 | `LEAD_MAX_SECONDS` .25 · `SYNC_INTERVAL_SECONDS` 2 · `MAX_FRAME_DT` .1 · `STALL_SECONDS` 1 · `CORRECTION_SMOOTH_SECONDS` .1 · `MAX_INTERPOLATION_DELAY_SECONDS` .1 | `GAIN` .25 · `NUDGE_MAX` .02 · `AXIS_QUANTUM` 1/64 |

Plus, in the session's own ticks: `ACK_STALL_TICKS` 60, `RING_TICKS` 48, `MAX_REPLAY_TICKS` 48. In world
units squared, `CORRECTION_SNAP_DISTANCE_SQUARED` 64². In seconds, `BUNDLE_DEADLINE_SECONDS` 30; in bytes,
`MAX_BUNDLE_BYTES` 8 MiB. In frames, `MAX_SNAPSHOT_CHUNKS` 256. And `DEFAULT_VIEWPORT`, the extent the
cursor quantum falls back to before the first `Welcome`.

## Traps

Each of these is load-bearing and reads as removable.

| Where                        | Do not                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `#checkNotBehind`            | move it into `#onState`: apply is frame step 2, the counter advances in step 3 — it resyncs a healthy session                        |
| `#checkLiveness`             | recover from `stalled` on any inbound envelope: that proves the server _sends_, not that it _processes_                              |
| `ACK_STALL_TICKS`            | count it in frames — it fires 7× early on a 144 Hz display over a 20 Hz sim                                                          |
| `RenderBridge.#destroy`      | check the immediate parent only: grandchildren leak stale map entries                                                                |
| `RenderBridge.#sample`       | date a segment from the older sample's own stamp: an entity that stood still crosses its next one in a frame                         |
| `RenderBridge.#trackFor`     | trust the map to hold no predicted entity: one that enters the scope keeps its track, and nothing samples it again to expire it      |
| `ClientClock.advance`        | store a non-finite `now`: every later `now - lastNow` is `NaN` for the session                                                       |
| `Mirror.discardMarks`        | assume `clear()` reaches the transform dirty set — it does not                                                                       |
| `Prediction.rewind`          | apply a delta without it: the entity table restores **whole**, so a spawn landed over a predicted world is undone by the next rewind |
| `Prediction.#remarkDirty`    | drop it: a store's `apply` marks no slot, and the bridge redraws only what the dirty set names                                       |
| `#cameraState`               | follow the simulated position: while the avatar eases toward it, the avatar slides across the screen                                 |
| `loadManifest`               | move the template loop after the `await`: the join snapshot then draws entirely as placeholders                                      |
| a refused child list         | register the template anyway: a bare pivot draws nothing, and the entity vanishes with no symptom                                    |
| `#resumeInput`               | re-assert a press unconditionally: after a stall the server still holds it and the handler fires twice                               |
| `BindingTable.#down`         | clear it on resync: the release edge for every key held across it is then never sent                                                 |
| `destroy()`'s `clearRuntime` | call it unconditionally: core keeps one module-global and a second client loses its own runtime                                      |

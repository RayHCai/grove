# `@platform/client` — internals

**TLDR.** The viewer, and the only package that owns a clock. It holds one `Transport` to the server, a
**script-less `@platform/core` runtime** it writes _only_ by applying server envelopes, device input
stamped with a tick, and the display loop that pushes transforms into `IRenderer`. It is
`@platform/server`'s wire peer — they agree through `@platform/protocol` and never import each other. It
has no authority, simulates nothing, and instantiates no creator scripts.

```
server ──state/transform envelopes──> Transport ──> Mirror (core runtime, inert passes)
                                          │                    │
       <──── input frames (one per tick) ──┘                    └──> RenderBridge ──> IRenderer
```

Deps: `core`, `math`, `protocol`, `renderer`, `transport`. Never `server`. No React.

## Layout

| File                                 | Owns                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| [src/client.ts](src/client.ts)       | `GameClient` — frame order, receive/dispatch, input flush, liveness, resync     |
| [src/mirror.ts](src/mirror.ts)       | `Mirror` — the script-less runtime and the only paths that write it             |
| [src/index-map.ts](src/index-map.ts) | `MirrorIndex` — bidirectional `netId ↔ EntityId`                                |
| [src/clock.ts](src/clock.ts)         | `ClientClock` — tick accumulator, lead loop, nudge, epoch, behind-check         |
| [src/ring.ts](src/ring.ts)           | `InputRing` — unacked frames, fold-at-prune horizon                             |
| [src/bindings.ts](src/bindings.ts)   | `BindingTable` — raw event → action edges, axis quantizer, held codes           |
| [src/input.ts](src/input.ts)         | Seams: `RawInputEvent`, `InputDevice`, `FrameSource` + scripted implementations |
| [src/handshake.ts](src/handshake.ts) | Join/time-sync builders, envelope narrowing, welcome validation, reject text    |
| [src/lifecycle.ts](src/lifecycle.ts) | `Lifecycle` — `SessionState`, `FailureReason`, input gating                     |
| [src/bridge.ts](src/bridge.ts)       | `RenderBridge` — `EntityId → NodeId`, manifest, dirty-set push, camera          |
| [src/constants.ts](src/constants.ts) | Engine constants, each stating its unit                                         |
| [src/browser/](src/browser/)         | DOM adapters behind the `./browser` subpath                                     |

Two exports: `.` (no DOM) and `./browser` (`createRafFrameSource`, `createPerformanceClock`,
`createDomInputDevice`, `pollGamepads`). `tsconfig.json` adds `lib: DOM` package-wide, since a project
reference cannot cover one subdirectory; the boundary is held by a `no-restricted-globals` override in
`.oxlintrc.json` denying `window`/`document`/`navigator`/`performance`/rAF outside `src/browser/`.

## The frame ([src/client.ts](src/client.ts))

`GameClient.frame(nowSeconds)` is the whole loop body; what calls it is injected (`FrameSource`), so a
browser passes rAF and a test drives it by hand.

1. `pump?.()` — loopback `deliver()`; a real socket has already delivered.
2. Drain the inbox **in arrival order**, one `apply` per envelope. Deltas are consumed in that order too;
   a set-union would create a node for a dead entity. Each dispatch is wrapped: an envelope that throws
   deeper than `asServerEnvelope` reaches fails the session as `peer`, because an exception escaping here
   unwinds through the frame source and ends the session with no state to show a person.
3. `clock.advance(now)` → 0..N tick indices (dt clamped inside), then flush one input frame per tick.
4. `#checkNotBehind()` → resync; `#checkLiveness()` → `stalled` in **both** directions; `#maybeSync()`.
5. `bridge.pushTransforms()`, `bridge.pushCamera()`, `renderer.render()`.

The push is after tick advance, not inside it: a frame that advanced three ticks still pushes once.
`start()` registers handlers _before_ sending the `JoinRequest`, so ordering never depends on transport
retention. `destroy()` is ordered reverse of setup and idempotent; it destroys the renderer only when
`ownsRenderer` is passed, and clears core's module-global runtime **only if that slot still holds its own**.

`#now` is always the **frame source's** seconds. The injected `ClockSource` is read only to stamp the join
and each `TimeSync`, so the two time bases never meet in one subtraction.

## Handshake ([src/handshake.ts](src/handshake.ts))

The client speaks first: `JoinRequest { protocolVersion, name, clientSentMs, token? }`. `Welcome` supplies
`simRate`, `sendRate`, `yourPlayerId`, `bounds`, `regions`, `visuals`, and `snapshot` (whose `tick` seeds
the clock). `isUsableWelcome` structurally validates **every field the join path dereferences** before
trusting it — including `bounds`, `regions`, `visuals` and `snapshot.state`, which are read unguarded — and
a `Welcome` that fails it is terminal and distinct from a `Reject`. `rttSeconds` differences **the stamp the
client recorded at send**, never the value the server echoed back, which is peer-controlled; a `TimeSync`
reply whose echo does not match the outstanding stamp is not ours and is dropped. `serverSentMs` is
observability. `asServerEnvelope` narrows on an exhaustive `kind` switch, never sniffing, and additionally
checks the depth-one fields the client walks without guarding — a `state` envelope whose `structural` is
absent is dropped at the boundary rather than throwing inside the mirror. Every array it will walk is
also bounded at `MAX_WIRE_ITEMS` before the walk, since the count is peer-chosen and the work is linear
in it. `TimeSync` refreshes every
`SYNC_INTERVAL_SECONDS` and is diagnostic after the seed.

## The mirror ([src/mirror.ts](src/mirror.ts))

`loadGame({ role: 'client' })`, then `rt.passes` is replaced with no-ops and `Loop` is held but never
stepped; no `startGame`. `rt.tick` is the **depicted** tick (set from the envelope, never incremented) and
is distinct from `clock.localTick`, the input tick — the only sound statement is `localTick >= depictedTick`.

Three write paths, and nothing else writes:

- `applyState(env)` → `MirrorDelta { added, removed, reparented, joined, left }` (**ordered lists, not
  sets**). Order: structural in journal order → `drainDestroyed()` + unmap once → `@serverState` diffs →
  `channels.clear()` → release any held transform envelope.
- `applyTransforms(env)` — **held** until the `StateEnvelope` of the same tick has landed; a superseded
  held envelope is dropped and counted, since transform is droppable by construction.
- `applySnapshot(welcome)` — the join snapshot replayed as `player-join` + `spawn` ops through
  `applyState`. Applied to a non-empty mirror this _is_ a resync. `reset()` empties the world for one.

Structural ops: `spawn`/`enter-interest` share one applier over `EntitySnapshot` (template, owner, parent,
tags, all transform fields — a static entity is dirty exactly once, so `spawn`'s position-only write would
strand scale/layer); `destroy`/`leave-interest`; `reparent` (**also reported on the delta**, since the
render tree cannot infer it); `tag`; `player-join` (mints a `Player` and `playerManager.adopt`s it, keeping
the **wire's** index); `player-leave`; `attach` dropped and counted.

`@serverState` arrives as one `StateDiff` per host carrying a `fields` bag, and lands directly in
`hosts.ensure(key).record.values` — one `StateDiff` per host, its `fields` map walked with
`Object.entries` — keyed with core's own `GAME_KEY` /
`playerKey` / `entityKey` helpers — with no scripts there is no hoisted accessor, and milestone 2's wiring
hoists onto the same record. `channels.clear()` discards structural and state marks (no consumer here) but
provably **not** the transform dirty set, which is the render bridge's work queue. Unknown `netId`s,
out-of-order parents, and a spawn whose `netId` is not a plausible server handle (not a non-negative safe
integer) are dropped/rooted and **counted** (`MirrorCounters`), never thrown. `#spawn` is the only place a
peer-chosen `netId` enters the map, so it is the only place that has to check.

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
  A `url` is **parsed and scheme-checked** first — `http:`, `https:` or relative only — because it is the one
  wire field that makes the client fetch an address the server chose; a refused entry is skipped, not fatal.
  The template half fills **before the first `await`**, so the caller may start it and reconcile the join
  snapshot without waiting. A rejection is counted (`ClientStats.assetLoadFailed`), never left unhandled.
- `reconcile(delta)` creates, **reparents**, then destroys from the ordered delta, never by diffing the
  world. Destroy collects **all descendants by ancestry** out of the map, since `destroyNode` cascades the
  subtree; the ancestry comes from the bridge's own `parent`/`children` index, which is also what makes a
  destroy cost the subtree rather than one renderer `parentOf` call per node per level.
- `pushTransforms` drains `consumeDirty()` — **slot indices**, resolved via `idAt`, released slots read as
  `NO_ENTITY` and are skipped — into one batched `updateNodes`.
- A missing or empty template draws `'__missing__'`, a name the renderer cannot reject, so one placeholder
  appears instead of the whole reconcile aborting.
- `pushCamera` sets the camera **every frame, unconditionally**; `viewport` reports world extent for the
  cursor quantum. `GameClient` resolves the local player's core `Camera` (follow target → live position)
  unless a `camera` resolver is supplied.

## Lifecycle ([src/lifecycle.ts](src/lifecycle.ts))

| State          | Entered when                                            | Input |
| -------------- | ------------------------------------------------------- | ----- |
| `connecting`   | `JoinRequest` sent, no `Welcome` yet                    | no    |
| `live`         | `Welcome` applied, clock seeded                         | yes   |
| `stalled`      | no envelope for `STALL_SECONDS`, **or** `ackSeq` frozen | no    |
| `resyncing`    | `localTick < depictedTick`, or a `RateChange`           | no    |
| `disconnected` | `onClose` fired                                         | no    |
| `failed`       | `Reject`, unusable `Welcome`, or a `TransportError`     | no    |

`failed` is terminal and absorbs later transitions. `FailureReason` distinguishes `rejected` (with phrased
reason + `serverProtocolVersion`), `undecodable`, `internal` (`encode-rejected` — our bug) and `peer`
(a malformed or hostile frame, including an envelope that threw while applying). Both stall triggers are
evidence about the _connection_; ring occupancy deliberately is not, or an energetic player could disable
their own controls. `RateChange` resyncs rather than retuning, because core does not retune pending timers,
the lag ring, or already-stamped input frames. A listener's throw is contained, so a UI bug cannot unwind
into the frame that changed state.

## Constants ([src/constants.ts](src/constants.ts))

Each constant states its unit in its own doc line, because mixing them is the failure mode (a tick is
16.7 ms at 60 Hz, 50 ms at 20 Hz) and the unit is wanted where the reader hovers it, not in a divider.

| Ticks                                    | Seconds                                                                                    | Dimensionless                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `HEADROOM_TARGET` 2 · `LEAD_MIN_TICKS` 1 | `LEAD_MAX_SECONDS` .25 · `SYNC_INTERVAL_SECONDS` 2 · `MAX_FRAME_DT` .1 · `STALL_SECONDS` 1 | `GAIN` .25 · `NUDGE_MAX` .02 · `AXIS_QUANTUM` 1/64 |

Plus, in the session's own ticks: `ACK_STALL_TICKS` 60, `RING_TICKS` 48. And `DEFAULT_VIEWPORT`, the extent
the cursor quantum falls back to before the first `Welcome`.

## Tests

`pnpm --filter @platform/client test` — 143 tests across five files in [tests/](tests/): `handshake`,
`mirror`, `clock`, `input`, `bridge`. No wall clock, no socket, no canvas: a scripted `ClockSource`,
`ManualFrameSource`, `ScriptedInputDevice`, `loopbackPair` and `createNullRenderer()`.
[tests/fake-server.ts](tests/fake-server.ts) is a protocol-conformant peer (`sendState`, `sendTransforms`,
`ackAll`, `ackWithHeadroom`, `sendRateChange`, `sendRaw`, reject/malformed modes) that makes every test a
black-box test of the real client — and is what `server` can later run against.

## Traps

Each of these is load-bearing and reads as removable.

| Where                        | Do not                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `#checkNotBehind`            | move it into `#onState`: apply is frame step 2, the counter advances in step 3 — it resyncs a healthy session |
| `#checkLiveness`             | recover from `stalled` on any inbound envelope: that proves the server _sends_, not that it _processes_       |
| `ACK_STALL_TICKS`            | count it in frames — it fires 7× early on a 144 Hz display over a 20 Hz sim                                   |
| `RenderBridge.#destroy`      | test the immediate parent only: grandchildren leak stale map entries                                          |
| `ClientClock.advance`        | store a non-finite `now`: every later `now - lastNow` is `NaN` for the session                                |
| `Mirror.#discardMarks`       | assume `clear()` reaches the transform dirty set — it does not, and the test pins it                          |
| A `FakeServer`               | advance its tick per display frame: a peer must tick at the rate it announces                                 |
| `loadManifest`               | move the template loop after the `await`: the join snapshot then draws entirely as placeholders               |
| `#resumeInput`               | re-assert a press unconditionally: after a stall the server still holds it and the handler fires twice        |
| `BindingTable.#down`         | clear it on resync: the release edge for every key held across it is then never sent                          |
| `destroy()`'s `clearRuntime` | call it unconditionally: core keeps one module-global and a second client loses its own runtime               |

## Not here

Interpolation (nodes step at `sendRate`); prediction and reconciliation (`Loop`, `ring.since()` and
`heldAtHorizon` exist unused for it); creator scripts (`attach` is counted, and `Loop.frame(dt)` does not
exist in core yet); automatic reconnect (`token` round-trips, but nothing retries); interest management
(both appliers exist, nothing sends the ops). The inbox is **unbounded** and a `resyncing` session that
never receives a `Welcome` waits forever — both are known gaps, not decisions.

## Corrections

What implementing and reviewing this corrected. A row here means the prose above once asserted the
opposite; reading what a sentence replaced tells you how far to trust the ones beside it.

| Claimed                                                 | Actually                                                                                                                                                                       | Caught by                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `tsconfig.json` adds `lib: DOM` for `src/browser/` only | It applies package-wide — a project reference cannot scope a subdirectory. Nothing stopped `client.ts` reaching `window`; a lint override now does.                            | Reading the config against the claim                                           |
| `reconcile` creates/destroys from the delta             | `reparent` reached core but never the render tree, so a reparented node kept its old parent's transform and rendered in the wrong place. `MirrorDelta` gained `reparented`.    | `bridge` — "follows a reparent into the render tree"                           |
| `rttSeconds` differences only the client's own stamps   | The stamp it differenced had round-tripped through the server, so it was peer-controlled. It now reads the stamp recorded at send.                                             | Review; the echo is checked for identity only                                  |
| `asServerEnvelope` checks rather than casts             | It checked `kind` and cast everything else, so a `state` envelope with no `structural` threw out of `frame()` — no `failed` state, no UI.                                      | `handshake` — "an untrusted frame ends up as state, never as a throw"          |
| `isUsableWelcome` validates before trusting it          | It validated five fields where the join path dereferences nine; `bounds`, `regions`, `visuals` and `snapshot.state` were unchecked.                                            | `handshake` — "treats a Welcome missing bounds as undecodable"                 |
| `rebind` drops an action's previous **button** bindings | It dropped every binding for the action, so rebinding a key silently removed that action's gamepad axis.                                                                       | `input` — "keeps an axis binding on the same action"                           |
| `BindingTable.reset()` is what a resync calls           | Nothing called it, and it was wrong for that case: a resync must clear the quantizer and **keep** the held set. Split into `forgetSentValues()`.                               | `input` — "keeps the held set, so a key held across a resync still releases"   |
| `pollGamepads(device)` polls the DOM device             | `createDomInputDevice` returned no `emit`, so the poller was uncallable with the only device it existed for. The return type now carries it.                                   | Review; typed as `EmittingInputDevice`                                         |
| `destroy()` clears the runtime                          | `clearRuntime()` nulls a core module-global, so tearing down one client broke a second — or a server in the same process.                                                      | Review; now guarded on identity                                                |
| `clear()` does **not** reach the transform dirty set    | Confirmed and still true — the bridge's work queue survives a mark discard.                                                                                                    | `mirror` — the property is pinned                                              |
| 126 tests across five files                             | Confirmed at the time; now 143, the additions all regression tests for the rows above.                                                                                         | `pnpm --filter @platform/client test`                                          |
| The client only had to parse what a server sent         | It also FETCHES one field: `WireAssetRef.url` reached `renderer.loadAssets` verbatim, so a hostile `Welcome` could make the browser fetch any URL at join. Scheme-checked now. | `bridge` — "refuses an asset URL whose scheme the loader must not fetch"       |
| Bounding inbound arrays was transport's job             | Transport caps bytes and depth, neither of which bounds cardinality; nothing capped the arrays the client walks. `MAX_WIRE_ITEMS` does, before the walk.                       | `handshake` — "drops a state envelope whose arrays exceed the cardinality cap" |

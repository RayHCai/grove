# `@platform/protocol`

**TL;DR** — the shared wire vocabulary, and nothing else. It declares every message that crosses the wire as
a TypeScript `type`, so `@platform/server` and `@platform/client` narrow to one definition instead of two that
drift. Types only: no bytes move here, no frame is validated here. It sits above `@platform/transport` and
`@platform/project` — its two dependencies — and below both endpoints.

**Authoritative for the wire** where this and the transport, server, or client design disagree.

---

## 1. Contents

| File               | Holds                                                          |
| ------------------ | -------------------------------------------------------------- |
| `src/ids.ts`       | `NetId`, `PlayerId`, `ProjectId`                               |
| `src/version.ts`   | `PROTOCOL_VERSION = 2`                                         |
| `src/envelopes.ts` | all eleven messages, both direction unions, every payload type |
| `src/index.ts`     | the barrel, grouped by concern; `PACKAGE_NAME`                 |

Runtime values exported: `PACKAGE_NAME`, `PROTOCOL_VERSION`. Everything else is a type.

Dependencies: `@platform/transport` — `src` imports exactly one type from it, `JsonValue` — and
`@platform/project`, whose authoring ids are exempt from the restatement rule in §5. `@platform/core` is
a **devDependency**, reachable only from the dev-only reference, so it cannot enter the shipped module graph.

## 2. The eleven messages

A message not in one of the two unions is not on the wire.

| `kind`            | Union            | Notes                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------- |
| `join-request`    | `ClientToServer` | first frame; `protocolVersion`, `name`, `projectId` + the two hashes      |
| `welcome`         | `ServerToClient` | rates, `bounds`, `regions`, `snapshot`, `visuals`, identity + `bundleUrl` |
| `snapshot-chunk`  | `ServerToClient` | part of a snapshot one frame cannot carry; `index`, sent ahead of it      |
| `reject`          | `ServerToClient` | `reason: 'version' \| 'full' \| 'identity'`, then `close()`               |
| `state`           | `ServerToClient` | **reliable**: `structural[]`, `state[]`, `ackSeq`, `earliestHeadroom?`    |
| `transform`       | `ServerToClient` | **droppable**: `transform[]`, joined to `state` by `tick`                 |
| `time-sync`       | `ClientToServer` | `clientSentMs`                                                            |
| `time-sync-reply` | `ServerToClient` | echoes the client stamp, adds `serverSentMs`, `serverTick`                |
| `manifest`        | `ServerToClient` | render-manifest **additions**, ahead of the spawn that first needs one    |
| `rate-change`     | `ServerToClient` | `tick`, `simRate`; the client resyncs rather than retunes                 |
| `input`           | `ClientToServer` | one frame per tick, `seq` + batched `actions[]`                           |
| `interaction`     | `ClientToServer` | one frame per tick, `tick` + batched `events[]`; no `seq`, so no ack      |

`Envelope` is both unions; `EnvelopeKind` is every `kind`. The unions are **disjoint**, so neither end can
accept a frame it minted.

**Payload types.** `WireStructuralOp` (nine arms: `spawn`, `destroy`, `reparent`, `tag`, `enter-interest`,
`leave-interest`, `player-join`, `player-leave`, `attach`) and `WireStructuralOpKind`; `StateHostAddr`,
`StateDiff`; `WireTransform`, `TransformDiff`; `EntitySnapshot`, `PlayerSnapshot`, `WorldSnapshot`;
`WireBounds`, `WireRegion`; `WireWrapperKind` and `WireWrapperState` (four arms: `Scoreboard`,
`Leaderboard`, `Inventory`, `Team`); `RenderManifest`, `WireAssetRef`, `WireAssetKind`, `TemplateVisual`
(`SpriteTemplateVisual` | `GroupTemplateVisual`), `TemplateChild` (`SpriteTemplateChild` |
`GroupTemplateChild`); `InputAction`, `InputPhase`; `Interaction` (four arms: `press`, `click`,
`hover-enter`, `hover-exit`) and `InteractionKind`.

## 3. Three type-level rules

Every envelope must be assignable to transport's `Message` (`JsonValue`). All three failures surface at the
`send` call as assignability errors that read like nothing to do with design.

1. **`type`, never `interface`** — an `interface` gets no implicit index signature.
2. **No `readonly` fields or arrays** — `readonly string[]` is not assignable to `JsonValue[]`.
3. **Optional means absent, never `undefined`** — `exactOptionalPropertyTypes` rejects it at compile time, and
   `jsonCodec.encode` throws at runtime for the value a socket actually produces. The carriers:
   `JoinRequest.token`, `Welcome.reconnectToken`, `StateEnvelope.earliestHeadroom`, `WireAssetRef.meta` (and
   its three members), `SpriteTemplateVisual`'s `anchorX` / `anchorY` / `tint` / `neverCull`,
   `InputAction.value`, the `press` arm's `screen`, `GroupTemplateVisual.children`, and every
   `TemplateChild` field but `kind` and a sprite child's `texture`.

Branded numbers, unions of `type` aliases, and intersections all pass — which is what makes `NetId` and the
flattened `TransformDiff` free.

## 4. Invariants an endpoint must honour

- **Identity.** The wire carries `NetId`, never a core `EntityId`. Numerically a `NetId` **is** the server's
  `EntityId`, cast at the send boundary; the brand stops either end assuming the number is local, because two
  runtimes that reached the same world through different histories hold different handles. The client owns the
  one `netId ↔ EntityId` map.
- **Apply order: structural → state → transform.** A transform for an unspawned `netId` fails silently and
  worse than a lost update — `initSlot` zeroes the write but does not clear the dirty bit, so the renderer gets
  a visible snap to the origin at scale 1.
- **The structural array is applied verbatim.** The ops do not commute; never group by kind.
- **A `StateDiff` names its host once and carries that host's fields as a map.** Field names are
  therefore KEYS, which puts them under the codec's reserved-key check — so a sender must drop a field
  named `__proto__` / `constructor` / `prototype` rather than emit it, and a receiver never sees one.
  The shape it replaced put the name in value position, where that check could not see it.
- **`state` is sent every send-tick, even when both arrays are empty**, because a `transform` envelope is held
  until the `state` envelope for the _same_ `tick` has been applied. `Welcome.snapshot` is the state envelope
  for its tick.
- **`ackSeq` is the highest contiguous _resolved_ seq for this connection** — applied _or_ definitively refused.
  A rate-limited or windowed-out frame is resolved; only a frame that never arrived is not.
- **`earliestHeadroom` absent ≠ 0.** Absent means the ack resolved no input, so the client holds its lead. `0`
  is a measurement: arrived exactly on time.
- **`StateHostAddr` → a _prefixed_ core host key.** Use core's `playerKey` / `entityKey` / `GAME_KEY`, and map
  `netId` → local `EntityId` _before_ building an entity key. `hosts.ensure` mints a record for whatever key it
  is handed, so a bare `'p1'` creates a second empty record and every write lands where no reader looks.
- **`WorldSnapshot.entities` is parents-before-children**, a real topological emit — core's slot order does not
  satisfy it, since parenting is a later mutation. A client rejects or roots-and-counts an out-of-order entity
  rather than silently rooting it.
- **An interest set is parent-closed**, and leaving is bottom-up. No server emits `enter-interest` /
  `leave-interest`; the arms are declared so interest management costs no breaking change to the union.
- **`spawn` and `enter-interest` carry a full `EntitySnapshot`** — all seven transform fields, `parent`,
  `owner`, `tags` — because transform is dropped first under backpressure and a static entity is dirty exactly
  once. The duplicate transform in the same tick's `transform` envelope is deliberate.
- **Every array and string arriving from a peer is bounded by the receiver**, cardinality and length both, and
  bounded _before_ the element walk — the count is peer-chosen and both validation and the work behind it are
  linear in it. No type here expresses a cap, because a cap is a receiver's policy and not a shape. Three layers
  hold one each: transport refuses a frame over `MAX_FRAME_BYTES` before parsing it, since parsing is what
  allocates; the server bounds the unauthenticated client → server surface (`MAX_ACTIONS_PER_FRAME`,
  `MAX_ACTION_NAME_LENGTH`, `MAX_ACTION_NAMES`, `MAX_INTERACTIONS_PER_FRAME`, `MAX_WIDGET_NAME_LENGTH`,
  `MAX_NAME_LENGTH`, `maxSeqGap`); the client bounds every array
  it walks at `MAX_WIRE_ITEMS` and refuses a `netId` that could not name a server handle. A `kind` check that
  narrows and then trusts is the shape of the bug. `TemplateChild` is the one recursive shape here, so a
  cardinality cap bounds nothing on its own — a receiver caps depth and total node count as well, or a peer
  spends the per-level cap to the power of the nesting. `Welcome.snapshotChunks` is a count that arrives
  across frames rather than inside one, so it is bounded too (`MAX_SNAPSHOT_CHUNKS`): every chunk it promises
  is memory the receiver holds before anything is applied.
- **A sender at the frame cap chunks; it never asks for a bigger frame.** The cap bounds what one parse
  allocates, which is the receiver's protection and not the sender's to spend — and a refused frame is
  unrecoverable on its own, since the client answers a broken session with a resync that asks for the same
  snapshot again. `snapshot-chunk` carries no tick and is never applied alone: chunks precede their
  `Welcome`, which names how many there were, and a set that does not add up is refused rather than
  half-applied. Their `entities` keep the whole snapshot's parents-before-children order, and entity chunks
  precede state chunks, since a `StateDiff` addressing an entity needs that entity to exist.
- **An `interaction` is a claim the authority cannot recompute, and is not input.** A widget's hit box is
  panel layout the server does not hold and a cursor position is meaningless without that client's camera,
  so both arrive already resolved — by widget name, and by `netId`. The receiver checks the entity is alive
  and nothing further; a handler that grants something must check reach itself. It carries no `seq`, so it
  is neither acked nor replayed: an interaction is one discrete event, not an edge of a sustained input, and
  a lost one is lost rather than re-derivable from the next sample. That is why it is its own frame — in
  `actions[]` every one of those rules would become conditional on a name.
- **`Welcome.visuals` is a baseline, not a session's whole manifest.** A template first used after a client
  joined reaches it on a `manifest` arm, which carries ADDITIONS the receiver merges — never a replacement,
  which would drop what the join established. It is sent _before_ the `state` envelope whose journal first
  spawns an entity of that template: a node created against a table that does not hold it draws the
  placeholder and keeps it for the session. It carries no `tick`, because a visual is not tick-ordered state.
- **The handshake proves both ends run the same bytes.** `projectId` and `projectHash` must agree, and a
  `JoinRequest.bundleHash` that is not `''` must match the server's — a client holding stale code is refused
  rather than left to diverge, since prediction replays its own input through that code and a divergence
  reads as jitter rather than as a fault. All three disagreements reject as `identity`.
- **`Welcome.bundleUrl` is executable**, so the client verifies `bundleHash` against the fetched bytes _before_
  evaluating them and evaluates the bytes it hashed rather than re-fetching the url, which could answer twice.
  The scheme is constrained exactly as `WireAssetRef.url`'s is; unlike an asset, a refused bundle fails the
  session rather than being skipped. `''` means the client's own build already holds the code.
- **`WireAssetRef.url` is an outbound fetch at an address the peer chooses**, and the only wire field that makes
  the client act on the network rather than just parse. `bridge.ts` copies it verbatim into the renderer's
  manifest, so a hostile `Welcome` would otherwise get a browser to fetch an arbitrary URL at join, before a
  frame is drawn. The receiver must constrain the scheme: the client parses it and admits `http:` / `https:` and
  relative paths only, dropping the entry rather than the join.
- **The handshake is codec-frozen JSON.** `join-request`, `welcome`, `reject` always ride `jsonCodec`; the
  negotiated codec takes effect after `Welcome`, implied by `protocolVersion` rather than carried as a field.
  Sound only under FIFO per direction, and not enforced anywhere: transport decodes with one injected codec per
  process before `onMessage` fires, so a binary-codec server fails a JSON `JoinRequest` inside transport, before
  protocol sees it.

## 5. Five types are restated, not imported

| Restated        | Mirrors                 | Why                                                           |
| --------------- | ----------------------- | ------------------------------------------------------------- |
| `InputPhase`    | core `EventPhase`       | core would put the simulation in a client's graph             |
| `WireAssetKind` | core `AssetKind`        | same; core's six kinds, not the renderer's four               |
| `WireTransform` | core `TransformBuffer`  | same, and it is an `interface` there — rule 1                 |
| `NetId`         | what `EntityId` _means_ | sharing the type is the correctness bug it exists to prevent  |
| `WireBounds`    | math `Bounds`           | math is a legal edge, but `Bounds` is an `interface` — rule 1 |

`InputPhase`, `WireAssetKind` and `WireTransform` are **parity-locked** to core through the dev-only reference,
mutually in both directions, so core widening _or_ narrowing breaks the build. `NetId` locks the opposite
relation — core's `EntityId` must _not_ be assignable to it — and `WireBounds` locks nothing, because four named
edges is a shape that does not grow.

`@platform/project`'s three authoring ids — `TemplateId`, `ScriptId`, `AssetId` — are the deliberate exception
to the table: they are imported rather than restated, because an id exists to name one thing in a saved file,
in an editor and on the wire, and a second copy defeats the only job it has.

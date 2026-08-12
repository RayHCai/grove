# `@platform/protocol`

**TL;DR** — the shared wire vocabulary, and nothing else. It declares every message that crosses the wire as
a TypeScript `type`, so `@platform/server` and `@platform/client` narrow to one definition instead of two that
drift. Types only: no bytes move here, no frame is validated here. It sits above `@platform/transport` (its
only dependency) and below both endpoints.

**Authoritative for the wire** where this and the transport, server, or client design disagree.

---

## 1. Contents

| File                       | Holds                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `src/ids.ts`               | `NetId`, `PlayerId`                                                    |
| `src/version.ts`           | `PROTOCOL_VERSION = 1`                                                 |
| `src/envelopes.ts`         | all nine messages, both direction unions, every payload type           |
| `src/index.ts`             | the barrel, grouped by concern; `PACKAGE_NAME`                         |
| `tests/envelopes.test.ts`  | compile-time assertions + a `jsonCodec` round-trip                     |
| `tests/codec-gate.test.ts` | transport's codec conformance suite, run from here against `jsonCodec` |

Runtime values exported: `PACKAGE_NAME`, `PROTOCOL_VERSION`. Everything else is a type.

Dependencies: `@platform/transport` — `src` imports exactly one type from it, `JsonValue`. `@platform/core` is
a **devDependency** and a reference of `tsconfig.test.json` alone, so it cannot reach the shipped module graph.

## 2. The nine messages

A message not in one of the two unions is not on the wire.

| `kind`            | Union            | Notes                                                                      |
| ----------------- | ---------------- | -------------------------------------------------------------------------- |
| `join-request`    | `ClientToServer` | first frame on a connection; carries `protocolVersion`, `name`             |
| `welcome`         | `ServerToClient` | rates, `bounds`, `regions`, `snapshot`, `visuals`; tick is in the snapshot |
| `reject`          | `ServerToClient` | `reason: 'version' \| 'full'`, then `close()`                              |
| `state`           | `ServerToClient` | **reliable**: `structural[]`, `state[]`, `ackSeq`, `earliestHeadroom?`     |
| `transform`       | `ServerToClient` | **droppable**: `transform[]`, joined to `state` by `tick`                  |
| `time-sync`       | `ClientToServer` | `clientSentMs`                                                             |
| `time-sync-reply` | `ServerToClient` | echoes the client stamp, adds `serverSentMs`, `serverTick`                 |
| `rate-change`     | `ServerToClient` | `tick`, `simRate`; the client resyncs rather than retunes                  |
| `input`           | `ClientToServer` | one frame per tick, `seq` + batched `actions[]`                            |

`Envelope` is both unions; `EnvelopeKind` is every `kind`. The unions are **disjoint**, so neither end can
accept a frame it minted.

**Payload types.** `WireStructuralOp` (nine arms: `spawn`, `destroy`, `reparent`, `tag`, `enter-interest`,
`leave-interest`, `player-join`, `player-leave`, `attach`) and `WireStructuralOpKind`; `StateHostAddr`,
`StateDiff`; `WireTransform`, `TransformDiff`; `EntitySnapshot`, `PlayerSnapshot`, `WorldSnapshot`;
`WireBounds`, `WireRegion`; `RenderManifest`, `WireAssetRef`, `WireAssetKind`, `TemplateVisual`
(`SpriteTemplateVisual` | `GroupTemplateVisual`); `InputAction`, `InputPhase`.

## 3. Three type-level rules

Every envelope must be assignable to transport's `Message` (`JsonValue`). All three failures surface at the
`send` call as assignability errors that read like nothing to do with design.

1. **`type`, never `interface`** — an `interface` gets no implicit index signature.
2. **No `readonly` fields or arrays** — `readonly string[]` is not assignable to `JsonValue[]`.
3. **Optional means absent, never `undefined`** — `exactOptionalPropertyTypes` rejects it at compile time, and
   `jsonCodec.encode` throws at runtime for the value a socket actually produces. Nine fields carry it:
   `JoinRequest.token`, `Welcome.reconnectToken`, `StateEnvelope.earliestHeadroom`, `WireAssetRef.meta` (and
   its three members), `SpriteTemplateVisual`'s `anchorX` / `anchorY` / `tint` / `neverCull`, and
   `InputAction.value`.

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
  `leave-interest` yet; the arms exist so adding interest management later is not a breaking union change.
- **`spawn` and `enter-interest` carry a full `EntitySnapshot`** — all seven transform fields, `parent`,
  `owner`, `tags` — because transform is dropped first under backpressure and a static entity is dirty exactly
  once. The duplicate transform in the same tick's `transform` envelope is deliberate.
- **Every array and string arriving from a peer is bounded by the receiver**, cardinality and length both, and
  bounded _before_ the element walk — the count is peer-chosen and both validation and the work behind it are
  linear in it. No type here expresses a cap, because a cap is a receiver's policy and not a shape. Three layers
  hold one each: transport refuses a frame over `MAX_FRAME_BYTES` before parsing it, since parsing is what
  allocates; the server bounds the unauthenticated client → server surface (`MAX_ACTIONS_PER_FRAME`,
  `MAX_ACTION_NAME_LENGTH`, `MAX_ACTION_NAMES`, `MAX_NAME_LENGTH`, `MAX_SEQ_GAP`); the client bounds every array
  it walks at `MAX_WIRE_ITEMS` and refuses a `netId` that could not name a server handle. A `kind` check that
  narrows and then trusts is the shape of the bug.
- **`WireAssetRef.url` is an outbound fetch at an address the peer chooses**, and the only wire field that makes
  the client act on the network rather than just parse. `bridge.ts` copies it verbatim into the renderer's
  manifest, so a hostile `Welcome` would otherwise get a browser to fetch an arbitrary URL at join, before a
  frame is drawn. The receiver must constrain the scheme: the client parses it and admits `http:` / `https:` and
  relative paths only, dropping the entry rather than the join.
- **The handshake is codec-frozen JSON.** `join-request`, `welcome`, `reject` always ride `jsonCodec`; the
  negotiated codec takes effect after `Welcome`, implied by `protocolVersion` rather than carried as a field.
  Sound only under FIFO per direction, and unenforceable until transport grows the switch: it decodes with one
  injected codec per process before `onMessage` fires, so today a binary-codec server would fail a JSON
  `JoinRequest` inside transport, before protocol saw it.

## 5. Five types are restated, not imported

| Restated        | Mirrors                 | Why                                                           |
| --------------- | ----------------------- | ------------------------------------------------------------- |
| `InputPhase`    | core `EventPhase`       | core would put the simulation in a client's graph             |
| `WireAssetKind` | core `AssetKind`        | same; core's six kinds, not the renderer's four               |
| `WireTransform` | core `TransformBuffer`  | same, and it is an `interface` there — rule 1                 |
| `NetId`         | what `EntityId` _means_ | sharing the type is the correctness bug it exists to prevent  |
| `WireBounds`    | math `Bounds`           | math is a legal edge, but `Bounds` is an `interface` — rule 1 |

`InputPhase`, `WireAssetKind` and `WireTransform` are **parity-checked** by type-level tests through the dev-only
core reference, in both directions, so core widening _or_ narrowing breaks the build. `NetId`'s test asserts the
opposite relation — that core's `EntityId` is _not_ assignable to it — and `WireBounds` has no check, because four
named edges is a shape that does not grow.

## 6. What writing the types corrected

| The doc claimed                                                               | The fact                                                                                                                                                                                                                                                                                                                         | Caught by                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rule 3's "three fields carry it"                                              | Nine declarations do, twelve counting `meta`'s members — an incomplete list read as exhaustive for the one rule a contributor has to apply.                                                                                                                                                                                      | `grep -c '?:' src/envelopes.ts`                                                  |
| `src` imports four transport types (`Codec`, `Message`, `Frame`, `JsonValue`) | It imports exactly one, `JsonValue`. The other three were never reached; §1's dependency line was right and README and the barrel header were not.                                                                                                                                                                               | `grep "from '@platform/transport'" src/`                                         |
| Source comments could cite this document by section number                    | 118 citations named 28 distinct sections, including subsections this doc has never had, so all 118 were stale and several resolved to a real but different section. Comments now state the constraint and never the number.                                                                                                      | Grepping every `§` against the headings                                          |
| The `Exact<T, U, V = T>` parity helper was safe as written                    | Correct at every call site, but any third argument disables the reverse direction while still compiling — `Exact<InputPhase, Drifted, string>` admits core drift. The parameter is not removable either: the two-parameter form is a circular constraint. Replaced by `Assert<IsMutual<A, B>>`, which has nothing spare to pass. | A fixture asserting simulated core drift, which the three-argument form admitted |
| `StateFieldDiff.field` is a prototype-pollution vector on apply               | It is not, but the `Map` in the client's mirror is the SOLE defense. Transport's pollution check inspects object keys and `field` crosses as a value, so `{field:'__proto__'}` decodes clean. A refactor to a plain-object record reintroduces it with nothing behind it.                                                        | Decoding `{host,field:'__proto__',value}` through `jsonCodec`, which accepts it  |
| A per-field `StateFieldDiff` was the right shape                              | It repeated the host address per field, the larger half of each entry, and put the field name in value position where the codec's reserved-key check cannot see it. Grouping under the host fixed both at once — density and the `__proto__` hole — which is why one change closed a performance finding and a security one.     | A test encoding both shapes, and decoding `__proto__` in each position           |
| The `NetId` brand is nominal per declaration site                             | Confirmed. `unique symbol` on a `readonly` property of a type alias is legal, and two aliases spelling the same brand key are mutually unassignable.                                                                                                                                                                             | `tsc` on two identically-spelled brands                                          |

# @platform/protocol

The shared wire vocabulary. **The one thing `@platform/server` and `@platform/client` both import**, so the
bytes one writes are the bytes the other reads.

It holds the **envelope types** — the handshake, the refusal, the reliable state diff, the droppable transform
diff, the input frame, the clock-sync pair — and later the **binary `Codec`** and **wire versioning**. It does
not hold `jsonCodec`, which stays in `@platform/transport` as the MVP default, and it does not move bytes:
transport does that.

This package exists because `Message` is `JsonValue` and the transport does no narrowing — inbound socket data
is untrusted, so a typed inbound value would assert a shape nothing verified. The endpoints validate and narrow
on receive, and protocol is where the types they narrow _to_ are defined once rather than twice.

Protocol sits **one layer above transport and below both endpoints**, importing one type from it, `JsonValue`,
and nothing else. It may not depend on core, the renderer, or either endpoint:
core would put the simulation in a client's module graph just to parse a frame and would let core's branded
`EntityId` reach the wire, the renderer would drag a rendering library into the headless server, and an
endpoint would be a cycle.

That first rule is why entity identity crosses the wire as an opaque branded `NetId`. Two runtimes mint
different handles for the same entity, so putting a local handle on the wire is a correctness bug, not a naming
choice. It is also why five types are restated rather than imported — core's `EventPhase`, `AssetKind` and
`TransformBuffer`, and math's `Bounds`, alongside `NetId` itself. The three core ones are pinned against core in
both directions by type-level tests that reach it as a **dev-only** reference, so a drift is a failed typecheck
rather than a wrong frame.

Three rules a contributor meets immediately, all of them assignability failures at the `send` call rather than
anything that reads as a design constraint. **Every envelope is a `type`, never an `interface`** — TypeScript
gives an `interface` no implicit index signature, so it is not assignable to `JsonValue`. **No `readonly`
fields or arrays** — `readonly string[]` fails the same way. **Optional means absent, never explicit
`undefined`** — `exactOptionalPropertyTypes` makes it a compile error, the same rule `jsonCodec` enforces at
runtime. Branded numbers, unions of `type` aliases, and intersections all pass, so the wire vocabulary costs
nothing here.

Because it is types only, its tests are compile-time ones and `pnpm typecheck` is the real assertion: every
envelope assignable to `Message`, both unions narrowing exhaustively, the snapshot's coverage table as an
exhaustive `Record` that fails when a tenth structural op is added unaccounted-for, and the transform fields
checked against core's own store. `tests/codec-gate.test.ts` runs transport's codec conformance suite from here,
which is the acceptance gate the binary codec must clear — pointed at `jsonCodec` until there is a binary one to
point it at.

The envelope catalogue and the reasoning are in [DESIGN.md](./DESIGN.md); this file is the short version. That
document is authoritative for the wire — the transport, server, and client designs each specified parts of the
protocol before this package existed, so where they disagree with it they are the ones that are wrong. Its final
section records what writing the types corrected in the design itself.

Status: **the envelopes have landed.** `src/{ids,version,envelopes,index}.ts` is the wire. The binary `Codec` is
still ahead, and must clear the conformance suite `tests/codec-gate.test.ts` already runs; `src/version.ts` holds
the version it will negotiate.

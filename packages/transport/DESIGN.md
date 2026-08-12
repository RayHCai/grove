# `@platform/transport`

**TL;DR** — A per-connection message pipe. One end of one _already established_ connection moves
opaque JSON values to its single peer with the value semantics of a real wire. It sits between
`@platform/server` (which drains core's replication channels) and `@platform/client` (which feeds
interpolation and prediction), and it is a **leaf**: no dependencies, no engine types, no clock. Two
run modes — networked and local — differ only in which implementation sits behind the interface.
Shipped today: the `Transport` seam, the `Codec` seam with `jsonCodec`, `loopbackPair`, and a reusable
codec conformance suite. **No WebSocket backend yet.**

`@platform/protocol/DESIGN.md` is authoritative for anything on the wire (envelope shapes, versioning,
the future binary codec). This file describes only what exists in this package.

---

## 1. Files

| Path               | Holds                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| `src/transport.ts` | `Transport`, `Message`, `Frame`, `EncodedFrame`, `TimerSource`, option types |
| `src/codec.ts`     | `Codec` interface + `jsonCodec` (validation, UTF-8 `byteLength`)             |
| `src/loopback.ts`  | `loopbackPair` and its pump                                                  |
| `src/errors.ts`    | `TransportError`, `TransportErrorCode`, `transportError()`                   |
| `src/testing/`     | `runCodecContract` — the gate every `Codec` clears, exported as `./testing`  |
| `src/index.ts`     | Barrel (`.` export)                                                          |
| `tests/`           | `codec.test.ts`, `loopback.test.ts` — 169 tests                              |

`src/transport.ts` imports nothing from an implementation. `transport.ts` ↔ `codec.ts` is a
**type-only** cycle (`import type` both ways), so nothing survives to emitted JS. The gate ships under
`src/` rather than `tests/` because `@platform/protocol` sits above transport and cannot reach `tests/` —
a gate the implementer cannot import is not a gate.

## 2. Public surface

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type Message = JsonValue; // untrusted on receive; endpoints narrow, transport never does
type Frame = string | Uint8Array; // string under jsonCodec
type EncodedFrame = Frame & brand; // minted only by Codec.encode

interface Transport {
    send(message: Message): void; // encode + enqueue to peer
    sendEncoded(frame: EncodedFrame): void; // fan-out: encode once, enqueue per connection
    onMessage(handler: (m: Message) => void): () => void;
    onClose(handler: () => void): () => void;
    close(): void;
}

interface Codec {
    encode(message: Message): EncodedFrame; // validate, then encode
    decode(frame: Frame): Message; // reject hostile/inadmissible, then return
    byteLength(frame: Frame): number; // wire bytes — what depth accounting reads
}

function loopbackPair(opts?: LoopbackOptions): LoopbackPair; // { client, server, deliver() }
declare const jsonCodec: Codec;
class TransportError extends Error {
    readonly code: TransportErrorCode;
}
```

Options: `codec` (default `jsonCodec`), `maxRetainedBytes` (default 1 MiB), `latency` (loopback only,
default `1`), plus `token` / `timer` on `ConnectOptions`. A bad `latency` (non-integer or negative) or
`maxRetainedBytes` (≤ 0) throws `invalid-option` from the factory.

**Type-only, not implemented:** `Connect` (`(url, opts?) => Promise<Transport>`) and `TimerSource`
exist so endpoints compile against the networked seam; `src/websocket.ts` does not exist. Also
exported: `PACKAGE_NAME`.

`EncodedFrame` is branded so `sendEncoded` accepts only a `Codec.encode` result — a hand-built or
foreign-codec frame is a compile error at the call site instead of a decode failure at the peer.
`decode` / `byteLength` take a plain `Frame` because they run on bytes that arrived from a peer.

## 3. `jsonCodec`

Validate-then-encode, both directions. A bare `JSON.parse(JSON.stringify(m))` is not enough: it drops
`undefined`/functions/symbols and turns `NaN`/`Infinity` into `null` **silently**, so a frame would
arrive changed — the divergence the copy exists to prevent.

**`encode` rejects (`encode-rejected`), naming the path (`player.stats.hp`, `[1][1].x`, or
`the message root`):** `undefined`, `NaN`, `±Infinity`, `BigInt`, functions, symbols, getters (never
invoked), `toJSON`, cycles, and any non-plain object — class instance, `Map`, `Set`, `Date`, `RegExp`,
`Uint8Array`, boxed primitive, null-prototype object. Nesting past **128** levels is rejected too, as
is an object key named `__proto__` / `constructor` / `prototype` — the same set `decode` refuses, so a
frame this codec produced is never one its own `decode` rejects. Expanding past **1,000,000** values
is rejected as well: the copy is made per REFERENCE, so a shared object multiplies rather than adds,
and depth alone bounds neither the work nor the frame.

**`encode` normalizes:** `-0` → `0` (falls out of ordinary arithmetic, so rejecting would throw on
real game data) and array holes → `null`. A **DAG is legal** — the same object referenced twice
arrives as two independent copies; only a true cycle is rejected.

**`decode` rejects:** a non-string frame or unparseable JSON (`malformed-frame`); `__proto__` /
`constructor` / `prototype` as an **object key** (`pollution-key` — rejected, never stripped; array
indices and string _values_ are fine); a number that overflowed to non-finite, e.g. `1e999`
(`unsupported-value`); nesting past 128 (`frame-too-deep`); more than `MAX_FRAME_BYTES` (4 MiB) of wire
bytes (`frame-too-large`), counted and refused BEFORE the parse, because the parse is what allocates.

**Both walks are iterative** with an explicit stack. A recursive walk — including a `JSON.parse`
reviver — overflows around 5,000 levels on a well-formed ~60 KB frame the byte cap does not catch,
and a `RangeError` is not a code a caller can act on. Depth, node count and byte count bound three
different things, and none implies the others.

`byteLength` counts UTF-8 by hand (no `Buffer`, no `TextEncoder` allocation; unpaired surrogate = 3
bytes) and returns `.byteLength` for a `Uint8Array`. UTF-16 `.length` would undercount every
non-ASCII character.

## 4. Loopback

An encoded-frame queue per direction, an encode in, a decode out. Each end owns its **inbox** and
writes into its peer's, which is what lets `close()` seal both directions.

- **Delivery is pumped, never self-driving.** Nothing is delivered outside `deliver()`, which the host
  application calls at the **top of each server tick**. So frames the server produces during `step()`
  land at the next tick's top: server→client is one tick behind, which keeps the client's
  prediction-and-reconcile path exercised locally instead of first running in production. The pump is
  **not re-entrant**: a `deliver()` from inside a handler throws `delivery-reentered`, because a nested
  pump ages both queues twice in one tick and `latency` would stop counting `deliver()` calls.
- **`latency`** counts `deliver()` calls (transport owns no clock) and defaults to 1 — the one-tick
  delay as a knob's default. At `latency: 0` a frame a handler just sent is already eligible, so
  `deliver()` loops to quiescence, capped at **1000 passes** before throwing
  `delivery-not-quiescent` (two handlers answering each other would otherwise hang). `deliver()` ages
  **both** ends before draining either, so the delay is not direction-dependent.
- **Strict FIFO per direction, outranking the delay** — a waiting frame holds everything behind it, so
  a delay can never become a reorder. Order is meaning for the structural channel.
- **Close rides the FIFO.** `close()` is idempotent; it enqueues a terminal marker into the peer's
  inbox (delayed by `latency`) and one into its own (undelayed — learning that you closed crosses no
  wire). `onClose` fires exactly once, on a drain, **never synchronously inside `close()`**, and after
  every frame ahead of it. After close: this end's `send`/`sendEncoded` are silent no-ops, and peer
  frames arriving into the sealed inbox are dropped rather than queued into something nothing drains.
  A dead peer must not abort a server's fan-out over the live ones.
- **Retention.** Frames arriving before a handler registers are held and flushed in order on
  registration (the join sequence races wiring order); retention resumes after a disposer runs. Capped
  at `maxRetainedBytes` (1 MiB, summed via `codec.byteLength`) and **only while no handler is
  registered** — a backlog behind a live handler is just a late pump, and it drains in O(1) per frame
  off a head index rather than a `shift()`, which went quadratic once the queue left V8's trimmable
  regime (100k frames: 4.4 s, now 41 ms). On overflow the frame is dropped
  and the condition latched, then thrown as `retention-overflow` from the **next `deliver()`** (not
  from the sender's stack, and not from a registration), once rather than every pump. The close marker
  is exempt from the cap.
- **One handler per end.** A second live `onMessage`/`onClose` throws `handler-already-registered` —
  two consumers would silently split one connection's frames. A stale disposer is harmless.
- **The drain shifts as it goes**, so a handler that throws propagates out of `deliver()` leaving the
  frames behind it queued; one that disposes itself leaves the rest retained; one that closes leaves
  everything behind the marker unconsumed.
- `send` encodes **before** the closed check, so a bad payload is the sender's bug either way rather
  than timing-dependent on which peer dropped first.

## 5. Error codes

| Code                         | Whose bug | Response                                     |
| ---------------------------- | --------- | -------------------------------------------- |
| `encode-rejected`            | ours      | defect above the transport — surface it      |
| `malformed-frame`            | peer's    | drop the frame, close the connection         |
| `pollution-key`              | peer's    | same                                         |
| `unsupported-value`          | peer's    | same                                         |
| `frame-too-deep`             | peer's    | same                                         |
| `frame-too-large`            | peer's    | same                                         |
| `retention-overflow`         | ours      | a join sequence that never wired `onMessage` |
| `delivery-not-quiescent`     | ours      | a `latency: 0` handler cycle                 |
| `delivery-reentered`         | ours      | a handler that called `deliver()`            |
| `handler-already-registered` | ours      | a wiring bug                                 |
| `invalid-option`             | ours      | a factory option it cannot honour            |

The union exists so a consumer can crash on its own bugs and merely close on a hostile peer's, which
message text cannot support.

## 5.1 Corrections

| This document claimed                                                                      | The fact                                                                                                                                                                                  | Caught by                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Validate-then-encode, **both directions**" with pollution keys listed only under `decode` | `encode` admitted `constructor` / `prototype` and emitted a frame its own `decode` refused as `pollution-key`, blaming the peer for a field a creator named                               | `handles a key that names a prototype slot the same way in both directions`  |
| Depth is capped "so the walk is bounded by policy"                                         | `MAX_DEPTH` bounds the ancestor chain, not the work: 23 objects nested 22 deep expanded to a 75 MB frame, 27 exhausted a 4 GB heap                                                        | `refuses a shared-reference graph that expands past the node budget`         |
| "Own enumerable string keys, which is exactly what `JSON.stringify` serializes"            | `copy[key] = value` hit the prototype setter for an own `__proto__`, so `encode` returned `{}` where `stringify` returned the key                                                         | `rejects an own __proto__ key rather than silently dropping it`              |
| A bad option "throws `encode-rejected` from the factory"                                   | Nothing was encoded; it is now `invalid-option`                                                                                                                                           | `rejects a latency that cannot count deliver() calls`                        |
| "a backlog behind a live handler is just a late pump"                                      | `shift()` per frame made the drain quadratic — 100k frames blocked the loop for 4.4 s; a head index makes it 41 ms                                                                        | measured, then `keeps counting deliver() calls when a handler tries to pump` |
| The pumped guarantee, stated without a re-entrancy clause                                  | A handler calling `deliver()` aged both queues twice, delivering a frame a tick early; now `delivery-reentered`                                                                           | `refuses a deliver() from inside a handler`                                  |
| `Transport` is the surface an end exposes                                                  | `link` / `receive` / `age` / `drain` were reachable at runtime on the handed-out object; `link` could re-point a live pair and `receive` could inject a frame past `encode` and the brand | `hides the pump members from a consumer holding one end`                     |

## 6. Conventions

- **Leaf.** No `dependencies`, no `references` in `tsconfig.json`.
- **No `node` or `DOM` types in `src/`** — hence the hand-rolled UTF-8 count.
- `NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where
  type-only, no runtime cycles.
- A future backend goes in its own file behind its own subpath export, so importing the interface
  never drags a socket library into the module graph.
- **Envelopes must be `type` aliases, not `interface`s** — an `interface` is not assignable to
  `Message` (no implicit index signature), and the failure reads as a confusing assignability error at
  the `send` call.

## 7. Consumers

`@platform/server` (`Transport`, `Codec`, `EncodedFrame`, `Message`, `TimerSource`, `jsonCodec`),
`@platform/client` (`Transport`, `Message`, `TransportError`), `@platform/protocol` (`JsonValue`, and
the codec gate), `@platform/engine` (dependency only).

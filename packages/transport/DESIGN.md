# `@platform/transport`

**TL;DR** — A per-connection message pipe. One end of one _already established_ connection moves
opaque JSON values to its single peer with the value semantics of a real wire. It sits between
`@platform/sim` (which drains core's replication channels) and `@platform/client` (which feeds
interpolation and prediction), and it is a **leaf**: no dependencies, no engine types, no clock. Two
run modes — networked and local — differ only in which implementation sits behind the interface.
It ships the `Transport` seam, the `Codec` seam with `jsonCodec`, `loopbackPair`, a WebSocket backend
behind `./websocket`, and a reusable codec conformance suite.

`@platform/protocol/DESIGN.md` is authoritative for anything on the wire (envelope shapes, versioning,
codec negotiation). This file describes only what exists in this package.

---

## 1. Files

| Path               | Holds                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `src/transport.ts` | `Transport`, `Message`, `Frame`, `EncodedFrame`, `TimerSource`, option types, the retention cap    |
| `src/codec.ts`     | `Codec` interface + `jsonCodec` (validation, UTF-8 `byteLength`)                                   |
| `src/inbox.ts`     | `FrameInbox` — the FIFO both backends drain: retention and its cap, the handlers, the close marker |
| `src/loopback.ts`  | `loopbackPair` and its pump                                                                        |
| `src/websocket.ts` | `connectWebSocket`, `webSocketTransport`, `WebSocketLike`, the heartbeat — `./websocket`           |
| `src/errors.ts`    | `TransportError`, `TransportErrorCode`, `transportError()`                                         |
| `src/testing/`     | `runCodecContract` — the gate every `Codec` clears, exported as `./testing`                        |
| `src/index.ts`     | Barrel (`.` export)                                                                                |

`src/transport.ts` imports nothing from an implementation. Both backends depend on `inbox.ts` and it
depends on neither: what an overflow or a `decode` rejection does is injected as a policy rather than
branched on there, and ageing is the caller's — loopback enqueues with a `due` and pumps, a socket
enqueues everything already due. `transport.ts` ↔ `codec.ts` is a **type-only** cycle (`import type`
both ways), so nothing survives to emitted JS. The gate ships under
`src/` behind its own `./testing` export because `@platform/protocol` sits above transport and must be
able to import it — a gate the implementer cannot reach is not a gate. Every case only a codec can
express arrives through `CodecContractOptions`: the frame-shaped fixtures default to JSON, so a
non-JSON codec supplies its own or passes **`null`** to skip a case its wire cannot express. `null` and
not an omitted key, because `exactOptionalPropertyTypes` makes an explicit `undefined` unassignable to
an optional property and a skip nobody can spell is not a skip.

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
function connectWebSocket(url: string, opts?: ConnectWebSocketOptions): Promise<Transport>; // dials
function webSocketTransport(socket: WebSocketLike, opts?: WebSocketOptions): Transport; // accepts
declare const jsonCodec: Codec;
class TransportError extends Error {
    readonly code: TransportErrorCode;
}
```

Options: `codec` (default `jsonCodec`), `maxRetainedBytes` (default 1 MiB, `DEFAULT_MAX_RETAINED_BYTES`,
one constant because every factory defaults to it), `latency` (loopback only, default `1`), and
`onError` / `maxBufferedBytes` / `timer` / `createSocket` (websocket only). A bad `latency` (non-integer
or negative), `maxRetainedBytes` or `maxBufferedBytes` (≤ 0) throws `invalid-option` from the factory,
as does a socket that is not OPEN — and the dial validates before it constructs a socket.

`Connect` (`(url, opts?) => Promise<Transport>`) is the networked seam endpoints compile against, and
`connectWebSocket` implements it. `ConnectOptions.token` reaches no wire: the reconnect token rides
`JoinRequest.token`, which protocol owns, and one credential with two channels is a second thing to
keep in agreement. Also exported: `RESERVED_KEYS` — the three object keys the codec
refuses, shared so a layer that answers them differently holds no second copy of the set.

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

**The cap is the receiver's protection, so a producer near it divides its payload rather than asking for a
bigger frame.** It bounds what one parse allocates on an untrusted path, and raising it to fit one sender's
largest message gives that bound away for every peer and every message. A producer sizes its own frames
against `MAX_FRAME_BYTES` — `Codec.byteLength` over an encoded frame is the measurement — and splits above
it; `@platform/sim` does this for a join snapshot, over its own budget held below this number so an
envelope's wrapper has room.

**Both walks are iterative** with an explicit stack. A recursive walk — including a `JSON.parse`
reviver — overflows around 5,000 levels on a well-formed ~60 KB frame the byte cap does not catch,
and a `RangeError` is not a code a caller can act on. Depth, node count and byte count bound three
different things, and none implies the others.

`byteLength` counts UTF-8 by hand (no `Buffer`, no `TextEncoder` allocation; unpaired surrogate = 3
bytes) and returns `.byteLength` for a `Uint8Array`. UTF-16 `.length` would undercount every
non-ASCII character.

## 4. Loopback

An encoded-frame queue per direction, an encode in, a decode out. Each end owns its **inbox** — a
`FrameInbox`, the same class the websocket backend stands on — and writes into its peer's, which is what
lets `close()` seal both directions. Retention, the close marker's place in the FIFO, the
single-handler rule and the drain below are the inbox's; the pump and `latency` are loopback's alone.

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
  off a head index rather than a `shift()`, which stops being cheap once the queue leaves V8's trimmable
  regime and a 100k-frame backlog is reachable at the cap, since the cap bounds bytes and a one-byte frame is
  legal. On overflow the frame is dropped and the condition latched,
  then thrown as `retention-overflow` from the **next `deliver()`** (not from the sender's stack, and not
  from a registration), once rather than every pump. The close marker is exempt from the cap.
- **One handler per end.** A second live `onMessage`/`onClose` throws `handler-already-registered` —
  two consumers would silently split one connection's frames. A stale disposer is harmless.
- **The drain consumes one entry at a time**, so a handler that throws propagates out of `deliver()` leaving the
  frames behind it queued; one that disposes itself leaves the rest retained; one that closes leaves
  everything behind the marker unconsumed.
- `send` encodes **before** the closed check, so a bad payload is the sender's bug either way rather
  than timing-dependent on which peer dropped first.

## 5. WebSocket

Two doors, because the two ends acquire a socket differently: `connectWebSocket(url, opts?)` dials and
resolves on OPEN, `webSocketTransport(socket, opts?)` wraps one a listener already accepted. The
listener stays outside the package — it needs a socket library and a leaf has no dependencies — so it
belongs to the composition root, and `webSocketTransport` is called in its connection handler
**synchronously**: retention covers a late `onMessage`, not a late transport. The dial fires once and
never retries: a reconnect rebinds a session to its `Player`, which is protocol's business and not a
pipe's.

- **`WebSocketLike` is structural**, because `src/` declares neither `node` nor `DOM` types; a browser's
  `WebSocket`, Node's global and `ws` all satisfy it. `send` takes `Uint8Array<ArrayBuffer>` rather than
  `Frame`'s wider `Uint8Array`, which also admits a `SharedArrayBuffer` backing no socket API accepts —
  with the wider type a real socket is not assignable. `binaryType` is typed `unknown` because the three
  implementations declare three different unions, and is set to `'arraybuffer'` at construction: a `Blob`
  frame would have to be awaited, and awaiting reorders frames. Listeners are **added**, never assigned
  over, since the root may hold one on the socket it accepted.
- **Delivery is not pumped** — the event loop is the pump, so there is no `deliver()` and no `latency`.
  One FIFO carries frames and the close marker together, which is what puts `onClose` behind every frame
  ahead of it however the two handlers registered; retention, its `maxRetainedBytes` cap and the drain
  are the **inbox's** — the same `FrameInbox` loopback stands on, with the overflow answer (reported once
  here, latched and thrown from the next pump there) and the decode-failure answer injected, and nothing
  ageing, since `due` is loopback's. A frame arriving after close is dropped, as it is into a sealed
  loopback inbox. `close()` queues no marker of its own: the socket's close event is the single source of
  one, and the standard queues that as a task, which is what keeps `onClose` out of `close()`'s stack.
- **`onError` carries what the seam cannot.** A `decode` rejection, a stalled peer, silence and an
  abnormal close arrive on socket events, where a throw lands where nothing can catch it — so each is
  reported there and the connection closes behind it, because `onClose` alone cannot tell a hostile peer
  from a clean quit. **At most one cause is reported per connection**, since the ordinary browser failure
  is an `error` event followed by a 1006 close — two views of one fault, which a consumer counting faults
  would otherwise see as two. A decode failure is the **peer's** here, unlike loopback where the sender's
  own `encode` minted the frame; a codec throw that is not a `TransportError` is ours and propagates, as
  does a throw from `onMessage`. With no `onError` registered the cause is lost but the close still
  happens. `retention-overflow` is outside this latch and has its own, because the connection survives it.
- **`close()` always writes 1000**, and inbound 1000 and 1001 are both clean — 1001 is a tab navigating
  away, and reporting it would make every page close look hostile. Any other code is `socket-error`,
  unless this end asked to close first, since an implementation may still report 1006 after a local
  close — which is why the end tracks `open` / `closing` / `closed` rather than one closed flag. A close
  code is not a protocol channel: protocol's `reject` is, and it precedes the close.
- **The heartbeat sends nothing.** `HEARTBEAT_INTERVAL_MS` (5 000) counts windows with nothing inbound,
  `MAX_MISSED_HEARTBEATS` (3) consecutive ones close the connection, so the cutoff falls between 10 and
  15 s — a frame may land just before a boundary. Protocol's messages are the whole wire and a browser
  cannot send a ping control frame, so liveness is read off traffic both directions already carry
  unprompted: `state` every send-tick, `time-sync` every 2 s. Any inbound frame resets the count, one the
  codec refuses included. The interval is cleared on every close path, because its closure holds the end.
- **`maxBufferedBytes`** (default `MAX_FRAME_BYTES`) bounds the socket's own `bufferedAmount` ahead of
  each send, and the connection closes past it. Sized off the frame cap rather than chosen: a peer
  refuses anything larger than one frame, so a longer backlog is a peer that stopped reading. Nothing
  above the transport can see `bufferedAmount`, so no layer above could hold this bound.

## 6. Error codes

| Code                         | Whose bug | Response                                       |
| ---------------------------- | --------- | ---------------------------------------------- |
| `encode-rejected`            | ours      | defect above the transport — surface it        |
| `malformed-frame`            | peer's    | drop the frame, close the connection           |
| `pollution-key`              | peer's    | same                                           |
| `unsupported-value`          | peer's    | same                                           |
| `frame-too-deep`             | peer's    | same                                           |
| `frame-too-large`            | peer's    | same                                           |
| `retention-overflow`         | ours      | a join sequence that never wired `onMessage`   |
| `delivery-not-quiescent`     | ours      | a `latency: 0` handler cycle                   |
| `delivery-reentered`         | ours      | a handler that called `deliver()`              |
| `handler-already-registered` | ours      | a wiring bug                                   |
| `invalid-option`             | ours      | a factory option it cannot honour              |
| `connect-failed`             | neither   | an address or a network — report it or retry   |
| `socket-error`               | neither   | the connection is gone; `onClose` follows      |
| `heartbeat-timeout`          | neither   | a half-open socket no close event would report |
| `send-buffer-overflow`       | peer's    | a peer that stopped draining the connection    |

The union exists so a consumer can crash on its own bugs and merely close on a hostile peer's, which
message text cannot support. Every code is thrown except on the websocket's receive paths, where the
last four and the frame rejections reach `onError` instead — a socket event has no catchable stack, and
`connect-failed` refuses the dial's promise rather than either.

## 7. Conventions

- **Leaf.** No `dependencies`, no `references` in `tsconfig.json`.
- **No `node` or `DOM` types in `src/`** — hence the hand-rolled UTF-8 count and `WebSocketLike`.
- `NodeNext` + `verbatimModuleSyntax`: explicit `.js` on relative imports, `import type` where
  type-only, no runtime cycles.
- A backend lives in its own file behind its own subpath export, so importing the interface never
  drags a socket into the module graph.
- **Envelopes must be `type` aliases, not `interface`s** — an `interface` is not assignable to
  `Message` (no implicit index signature), and the failure reads as a confusing assignability error at
  the `send` call.

## 8. Consumers

`@platform/sim` (`Codec`, `Message`, `jsonCodec`) and its hosts (`Transport`, `EncodedFrame`, `TimerSource`),
`@platform/client` (`Transport`, `Message`, `TransportError`), `@platform/protocol` (`JsonValue`, and
the codec gate), `@platform/project` (`JsonValue`), `@platform/engine` (dependency only).

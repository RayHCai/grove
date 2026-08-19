# @platform/transport

A per-connection message pipe, with a loopback implementation and a websocket backend.

The `Transport` interface — `send` / `sendEncoded` / `onMessage` / `onClose` / `close` — is the pipe
between `@platform/server` (which drains core's three replication channels) and `@platform/client`.
**It names no engine type: transport is a leaf of the package graph, beside `@platform/math`.** One
interface serves both run modes — **networked** (N clients, one remote server) and **local** (one client,
a co-located server over `loopbackPair()`, no deployment to stand up); only the implementation behind it
changes, which is what keeps the "no solo-versus-networked fork" promise (api_design.md §1.1). Local mode
drops the server _deployment_, not the server: there is no client-authoritative path and no local co-op
mode.

The wire codec is an injected `Codec { encode, decode, byteLength }` seam — the same shape as core's
`ReplicationSink` / `KVStore`. Transport ships `jsonCodec` as the default and a **conformance suite**
every codec must pass before it can be injected, exported as `@platform/transport/testing` so the
implementer of the next codec can actually run it; `@platform/protocol` (a second leaf both endpoints
import) supplies the shared envelope types and the `PROTOCOL_VERSION` the handshake stamps. The codec is
process-uniform, which is what makes encode-once fan-out (`sendEncoded`) sound — and `encode` returns a
branded `EncodedFrame` that `sendEncoded` alone accepts, so a frame from anywhere else is a compile error
at the call site rather than a decode failure at the peer. `Message` is `JsonValue` and the transport does
no narrowing, because inbound data is untrusted — endpoints validate and narrow on receive.

The loopback implementation is an encoded-frame queue per direction, pumped once at the top of each
server tick — so server→client is one wire-faithful tick behind, which keeps the client's prediction
path exercised in local mode rather than dead until production. That delay is a **knob's default**
(`latency`, counted in `deliver()` calls) rather than a constant: `latency: 0` delivers inside one pump,
which is what tells a prediction bug from a simulation bug in a single run. The **validate-then-encode**
copy is a correctness device, not overhead: it gives an in-process peer the same value semantics a socket
enforces (no shared references), throws on anything the wire would silently transform (`undefined`, `NaN`,
a stray function), and rejects prototype-pollution keys, over-deep nesting, and a frame over 4 MiB on
decode — so a frame that forgets to encode properly, or a hostile inbound shape, fails locally instead
of surfacing as a networked-only bug. The byte cap is checked before the parse, because the parse is
what allocates. Both validation walks are iterative: a recursive one overflows the stack on a
well-formed frame the byte cap does not catch.

The websocket backend is the same interface over a real socket, behind `@platform/transport/websocket`
so importing the seam never drags one into the module graph. It has **two doors**, because the two ends
come by a socket differently: `connectWebSocket(url)` dials and resolves only once the socket is OPEN —
so a caller never holds an unconnected `Transport` — while `webSocketTransport(socket)` wraps one a
listener already accepted. The listener stays out of this package: it needs a socket library, and a leaf
has none, so a `ws` server belongs to the composition root. The socket itself is typed structurally, so a
browser's `WebSocket`, Node's global and `ws` all fit with no `@types` anywhere. Delivery needs no pump
here — the event loop is the pump — and there is no `latency` knob, but retention, FIFO order, one
handler per end and a close that lands behind every frame ahead of it all hold exactly as they do in
loopback. Two things a socket adds: a **heartbeat** that sends nothing and merely closes a connection
that has been silent for three 5 s windows, since a half-open socket is one no close event will ever
report; and a **`maxBufferedBytes`** cap on the socket's own unsent bytes, because a peer that has
stopped draining for a whole frame's worth is dead and holding its backlog is memory that never comes
back. Failures a socket produces and loopback cannot — a hostile frame, silence, a stalled peer, an
abnormal close — arrive on socket events where a throw would land where nothing can catch it, so they
are reported to an **`onError`** option and the connection closes behind them; `onClose` alone cannot
tell a hostile peer from a clean quit.

Four rules a consumer meets immediately. **One handler per end:** `onMessage` / `onClose` take a single
handler, and a second live registration throws — two consumers of one connection would silently split its
frames. **Register `onMessage` before the first `deliver()`:** frames that arrive earlier are retained and
flushed on registration, but only up to `maxRetainedBytes` (1 MiB), past which the next `deliver()` throws
`retention-overflow` rather than growing forever. **Never call `deliver()` from a handler:** the pump is
not re-entrant and throws `delivery-reentered`, since a nested pump would age both queues twice in one
tick and deliver a frame earlier than `latency` promises. **Failures carry a code:** every throw is a
`TransportError` with a `TransportErrorCode`, because `encode-rejected` is a bug above the transport while
`malformed-frame` / `pollution-key` / `unsupported-value` / `frame-too-deep` mean a hostile or mismatched
peer, and the correct response differs (drop and close, never crash).

```ts
import { loopbackPair } from '@platform/transport';

const pair = loopbackPair(); // connected at construction; codec defaults to jsonCodec
pair.server.onMessage((message) => {
    /* validate and narrow — this crossed a wire */
});

// the host application's loop, at the TOP of each server tick:
pair.deliver(); // inbound arrives here
step(); // outbound enqueued here reaches the peer next tick

// diagnosing a desync: if it survives this, it is not a prediction bug
const instant = loopbackPair({ latency: 0 });
```

The same interface over a socket, on each end:

```ts
import { connectWebSocket, webSocketTransport } from '@platform/transport/websocket';

// client: resolves once the socket is OPEN, so this is already connected
const transport = await connectWebSocket('wss://host/game', {
    onError: (error) => console.error(error.code, error.message),
});

// server: in the listener's connection handler, synchronously — a frame that arrives before the
// transport exists is gone, and retention only covers a late onMessage.
wss.on('connection', (socket) => {
    server.accept(webSocketTransport(socket, { onError: report }));
});
```

And the conformance suite, which any new codec must pass before it may be injected:

```ts
import { runCodecContract } from '@platform/transport/testing';

runCodecContract(() => myBinaryCodec, { name: 'binaryCodec' });
```

The full rationale and the interface are in [DESIGN.md](./DESIGN.md); this file is the short version.

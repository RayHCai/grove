# @platform/transport

A per-connection message pipe, with a loopback implementation and a websocket backend to come.

The `Transport` interface — `send` / `sendEncoded` / `onMessage` / `onClose` / `close` — is the pipe
between `@platform/server` (which drains core's three replication channels) and `@platform/client`.
**It names no engine type: transport is a leaf of the package graph, beside `@platform/math`.** One
interface serves both run modes — **networked** (N clients, one remote server) and **local** (one client,
a co-located server over `loopbackPair()`, no deployment to stand up); only the implementation behind it
changes, which is what keeps the "no solo-versus-networked fork" promise (api_design.md §1.1). Local mode
drops the server _deployment_, not the server: there is no client-authoritative path and no local co-op
mode (DESIGN §14).

The wire codec is an injected `Codec { encode, decode, byteLength }` seam — the same shape as core's
`ReplicationSink` / `KVStore`. Transport ships `jsonCodec` as the default and a **conformance suite**
every codec must pass before it can be injected, exported as `@platform/transport/testing` so the
implementer of the next codec can actually run it; `@platform/protocol` (a second leaf both endpoints
import) supplies the binary codec, the shared envelope types, and wire versioning later. The codec is
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

And the conformance suite, which any new codec must pass before it may be injected:

```ts
import { runCodecContract } from '@platform/transport/testing';

runCodecContract(() => myBinaryCodec, { name: 'binaryCodec' });
```

The full rationale, the interface, and the ordered networked roadmap are in [DESIGN.md](./DESIGN.md);
this file is the short version.

Status: **implemented through DESIGN §8**, plus §13's hardening — `Transport`, `Codec` / `jsonCodec`, the
conformance suite, and `loopbackPair`, under 169 tests. The WebSocket backend and the rest of §9's
networked path are next.

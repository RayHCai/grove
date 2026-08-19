# @platform/server

The authority. It is the one process that owns the true world: it holds core's runtime, steps it on a
real-time accumulator, admits and buffers client input, and broadcasts the resulting state diffs to every
connected client.

It sits above the transport (which moves opaque frames) and above core (which owns simulation but no clock
and no network). **It is the seam between them** — where core's `ReplicationSink` obligation is finally met,
and where a `Transport` per player is finally held. `@platform/client` is its wire peer, and the two share
exactly one thing: the envelopes in `@platform/protocol`. It never imports the client.

See [DESIGN.md](DESIGN.md) for the internals.

## What it owns

Connection acceptance and the per-connection registry; player allocation at join and the join reply, whose
snapshot it builds by walking the live world; construction of the authoritative world through core's
`loadGame`; the real-time→tick accumulator with a per-wake step cap and its shed-time input policy; the
tick-indexed input buffer and its jitter scheduling; the admission checks; the `hold` synthesis the wire's
edges-only input frames leave to the tick loop; the call into `Loop.step`; and the post-step drain of core's
three replication channels into tick-stamped envelopes broadcast to every connection.

It is the **policy** layer. It decides _which_ tick an input applies to, _whether_ an input is admissible,
_when_ to broadcast, and _what_ each connection is owed — never how a byte crosses a wire, and never what a
`SyncedScript` computes.

## What it does not own

What a frame _means_ on the wire beyond the envelope shape: encoding is the injected `Codec` and the envelope
types live in `@platform/protocol`. The simulation itself — entities, dispatch, `@serverState`, the tick
order — all of which is core's. The reliability class of a frame, which is the transport's. Prediction and
interpolation, which are the client's. And the byte movement, which is the transport's.

It also does not open sockets. A `Transport` is one end of one established connection, so standing up a
listener is a factory concern: transports arrive from `loopbackPair()` or from `webSocketTransport(socket)` in
a listener's connection handler, and the composition root wires them into `accept`.

## Using it

```ts
import { GameServer } from '@platform/server';
import { loopbackPair } from '@platform/transport';

const pair = loopbackPair();
const server = new GameServer({
    config: { simRate: 60, sendRate: 20, maxPlayers: 8, bounds, gameScripts: [Rules] },
    // Handed to the DRIVER, which calls it first inside every pump — never sequenced by the host.
    deliver: pair.deliver,
});

// The id, or null if the socket was refused and closed.
server.accept(pair.server);

// One call per iteration. The pump owns deliver→step, so it cannot be called out of order.
requestAnimationFrame(function frame(ms) {
    server.pump(ms / 1000);
    requestAnimationFrame(frame);
});

// Shutdown: stops the driver and closes every connection. `stop()` only parks the driver.
server.close();
```

Networked, `deliver` is omitted — the socket's own event loop has already dispatched inbound frames — and
`server.start()` self-drives off an injected `TimerSource`. Mode-awareness is that one optional field,
supplied by the small amount of code that already knows which factory it used.

## It owns a clock, but does not build one

Unlike core (pumped, never self-driving) and unlike the transport (buffered, pumped by its host), this is the
layer that advances real time into ticks. But it never reads `Date.now()` or calls `setInterval`: the clock
arrives as `pump(now)`, or as an injected `TimerSource` when it self-drives. So the whole server runs against a
scripted clock with no wall clock and no socket.

The accumulator has a per-wake step cap. Past it, the server **sheds** unsimulated wall-clock rather than
carrying it, so a hitch cannot compound into the spiral of death. What a shed discards is wall-clock, never
tick indices: the tick counter stays contiguous, and input buffered for a skipped tick is applied late rather
than abandoned — so a shed is a visible slowdown rather than a silently lost input.

# @platform/client

The viewer. It owns a screen and a person: one `Transport` to the server, a script-less mirror of the
authoritative world that it only ever writes by applying what the server sent, device input stamped with a
tick, and the display loop that pushes transforms into `IRenderer`.

It is `@platform/server`'s wire peer, and the two share exactly one thing: the envelopes in
`@platform/protocol`. It never imports the server.

See [DESIGN.md](DESIGN.md) for the internals — its Corrections section records what implementing and
reviewing it corrected.

## What it owns

The connection and handshake; the local tick counter and the lead that keeps it ahead of the server; the
mirror world and the single path that writes it; the `netId → EntityId` map; device capture and its mapping
to actions; the tick-stamped input frame and the ring of unacknowledged inputs; the `EntityId → NodeId` map
and the per-frame push into the renderer; the display loop; and the lifecycle states a person can see.

It owns no authority over anything, and simulates nothing — no movement, contacts, regions or physics. It
instantiates no creator scripts in the MVP; interpolation and prediction are milestones 3 and 4.

## Using it

```ts
import { GameClient } from '@platform/client';
import {
    createDomInputDevice,
    createPerformanceClock,
    createRafFrameSource,
} from '@platform/client/browser';

const client = new GameClient({
    transport, // from @platform/transport's connect() or loopbackPair()
    renderer, // an initialized IRenderer
    frames: createRafFrameSource(),
    device: createDomInputDevice(),
    clock: createPerformanceClock(),
    name: 'Ray',
    bindings: [{ kind: 'button', code: 'keys:Space', action: 'jump' }],
});
client.start();
```

**The DOM adapters live behind `@platform/client/browser`**, so importing the session and its seams does not
pull a DOM adapter into the module graph. A Node test imports the root barrel and injects
`ManualFrameSource`, `ScriptedInputDevice` and a scripted clock — which is how the whole package is tested:
no wall-clock, no socket, no canvas.

A React host composes rather than competes: a hook that owns the renderer's lifecycle calls
`client.frame(now)` from its own rAF loop, so the hook _is_ the client's `FrameSource`.

`tests/fake-server.ts` is a protocol-conformant peer over the other end of a `loopbackPair`. It makes every
test here a black-box test of the real client, and it is what `@platform/server` can later run against to
prove the two halves agree.

# @platform/client

The viewer. It owns a screen and a person: one `Transport` to the server, a mirror of the authoritative
world, device input stamped with a tick, and the display loop that pushes transforms into `IRenderer`. The
mirror is written by what the server sent and — when prediction is on — by replaying the input the server
has not acknowledged yet, over a baseline it can rewind to.

It is `@platform/server`'s wire peer, and the two share exactly one thing: the envelopes in
`@platform/protocol`. It never imports the server.

See [DESIGN.md](DESIGN.md) for the internals.

## What it owns

The connection and handshake; the local tick counter and the lead that keeps it ahead of the server; the
mirror world and the paths that write it; the `netId → EntityId` map; device capture and its mapping to
actions; the tick-stamped input frame and the ring of unacknowledged inputs; the rewind-and-replay that
carries the local player's own entities to the tick they are pressing keys on; the `EntityId → NodeId` map
and the per-frame push into the renderer; the buffer that draws everything else between the poses the server
sent, so the send rate is not its visible motion rate; the display loop; and the lifecycle states a person
can see.

It owns **no authority** over anything. What it simulates is provisional and scoped to the entities the
local player owns: the authoritative pose is restored before every delta, contacts are never fired here, and
a correction the server hands back is eased on screen while the simulation takes the server's exact answer.
Everything outside that scope is interpolated instead — an entity is smoothed by one path or the other,
never by both.

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
    // Simulates the local player's own entities ahead of the server, replaying unacked input over
    // every authoritative delta — running the scripts below, which are what it has to replay.
    predict: true,
    // Attached by template, since the wire names a class this end cannot resolve. `SyncedScript`
    // only: a `ServerScript` never runs on a client tick.
    scripts: { player: [Runner] },
});
client.start();
```

**The DOM adapters live behind `@platform/client/browser`**, so importing the session and its seams does not
pull a DOM adapter into the module graph. A Node host imports the root barrel and injects
`ManualFrameSource`, `ScriptedInputDevice` and a scripted clock instead: no wall clock, no socket, no canvas.

A React host composes rather than competes: a hook that owns the renderer's lifecycle calls
`client.frame(now)` from its own rAF loop, so the hook _is_ the client's `FrameSource`.

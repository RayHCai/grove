# @platform/sim

The deterministic fixed-step advance: **one input batch in, one output batch out**.

It holds core's runtime and everything between a decoded inbound frame and an outbound envelope —
the narrowing, admission, the tick-keyed input buffer, the join and its snapshot, the call into
`Loop.step`, and the drain of core's three replication channels. `@platform/client` is its wire
peer, and the two share exactly one thing: the envelopes in `@platform/protocol`. It never imports
the client.

See [DESIGN.md](DESIGN.md) for the internals.

## The whole surface

```ts
import { Sim } from '@platform/sim';

const sim = new Sim({
    config: { simRate: 60, sendRate: 20, maxPlayers: 8, bounds, gameScripts: [Rules] },
});

const out = sim.tick({
    nowMs, // the host's wall clock, stamped into two envelopes and differenced against nothing
    drain: true, // whether this tick closes a send interval — the cadence is the host's
    opened: [{ connectionId: 'c1', identity: 'alice' }],
    frames: [{ connectionId: 'c1', message }],
    closed: [],
    records: [], // answers to the loads an earlier batch asked for
    saved: [], // host keys whose save has landed
});

// Everything the host must now do, and nothing it must work out for itself.
out.sends; // { to: ConnectionId[], envelope, class: 'reliable' | 'droppable' }
out.closes; // sockets to close, after the frames already queued for them
out.loads; // persisted reads a join is waiting on
out.saves; // a departing player's record, to write through
out.log; // one line per denial, in the tokens an operator greps for
```

`close()` is the shutdown: every session leaves inline, so the batch it returns carries the last save
each of them is owed.

## What it does not own

**A socket, a clock, a store or a codec for I/O.** It opens nothing, reads no time, and cannot
persist anything: the time it stamps arrives in the batch, and a persisted record is asked for in one
output batch and answered in a later input batch. Two hosts drive it — `@grove/host` in Rust for a
deployed session, and `@platform/glue`'s `GameInstance` in process for local play, the test suites
and the integration suite.

The one codec it does hold encodes nothing for the wire: it **measures** whether a `Welcome` must be
split into chunks, so it must be the same codec the host encodes with.

Also not its: encoding and envelope shapes (`@platform/protocol`), the simulation itself (core), and
prediction and interpolation (the client).

## Why the batch, and not a socket

A shape this narrow is what lets the host be a different language — the Rust host runs this bundle in
a V8 isolate and speaks to it through exactly the two types above. It is also what would let this
advance run **in a browser**, where there is no socket, no store and no clock to give it: nothing
here imports `node:` anything and nothing reads ambient state. `@platform/client` does not do that
today — it re-produces the input fold itself in `passes.ts` — so that is a property of the shape
rather than a wire in place.

It is also what makes a tick replayable. Everything that reaches the world reaches it at the top of a
tick, in the order the batch names, so a session is a sequence of batches and nothing else.

## The tick counter is contiguous, always

`tick()` steps exactly one tick and always `tick + 1`. That is forced by core rather than preferred:
timers and tweens advance one unit per `step()` call whatever index they are handed, so a host that
skipped indices would compress every `after`, `every`, `sleep` and tween by the gap.

Falling behind is therefore the host's to shed in **wall-clock**, never in ticks — it simply calls
`tick` fewer times than real time owed. Input buffered for a tick the world has already passed is
merge-forwarded, so a shed costs latency rather than existence.

## Running inside a host's isolate

A host with no module loader reaches a bundle through one global. `installIsolateEntry` publishes it,
and a game bundle's entry file is the three lines that name the world it knows how to build:

```ts
import { installIsolateEntry } from '@platform/sim';
import { createSim } from '@platform/engine/host';
import { PROJECT } from './project.js';
import { SERVER_SCRIPTS } from './registry.js';

installIsolateEntry(() => createSim(PROJECT, { scripts: SERVER_SCRIPTS }));
```

`boot(config)`, `tick(batch)` and `close()` then take and answer JSON, because a string is the only
shape a host in another language can hold — and because a world that booted at evaluation time would
run every Game `@onStart` before the host had a clock to advance them with.

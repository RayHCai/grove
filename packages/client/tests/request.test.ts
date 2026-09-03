// `request()` from a client: it leaves this process rather than running here.
//
// Server-to-client is implicit replication and client-to-server is always an explicit, checked
// request — so the half that matters is the negative one. A client that dispatched locally would be
// validating an untrusted ask on the untrusted machine, and against a mirror that holds no
// authoritative state to check it against.
//
// Compiled by the build (src/testkit/fixtures.ts); this file carries no decorator syntax.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime, request, withRuntime } from '@platform/core';
import type { RequestFrame } from '@platform/protocol';
import { createReadyNullRenderer } from '@platform/renderer/null';
import { loopbackPair } from '@platform/transport';
import { LocalVault } from '../dist/testkit/fixtures.js';
import { GameClient } from '../src/client.js';
import { MAX_REQUESTS_PER_FRAME } from '../src/constants.js';
import { ManualFrameSource, ScriptedInputDevice } from '../src/input.js';
import { FakeServer } from './fake-server.js';

const TICK = 1 / 60;

interface Harness {
    client: GameClient;
    server: FakeServer;
    run(n?: number): void;
    /** Calls `request()` the way creator code does: under the ambient mirror runtime. */
    ask(name: string, payload?: Record<string, unknown>): void;
    requests(): RequestFrame[];
}

async function harness(): Promise<Harness> {
    const pair = loopbackPair({ latency: 1 });
    const server = new FakeServer(pair.server);
    const renderer = await createReadyNullRenderer({ design: { width: 800, height: 600 } });
    const frames = new ManualFrameSource();
    let now = 0;

    const client = new GameClient({
        transport: pair.client,
        renderer,
        frames,
        device: new ScriptedInputDevice(),
        clock: { nowSeconds: () => now },
        name: 'Ray',
        pump: () => pair.deliver(),
    });

    const h: Harness = {
        client,
        server,
        run(n = 1): void {
            for (let i = 0; i < n; i++) {
                now += TICK;
                server.tick++;
                if (server.welcomed && server.tick % 3 === 0) server.ackAll();
                frames.frame(now);
            }
        },
        ask(name, payload): void {
            const rt = client.mirror?.runtime;
            if (rt === undefined) throw new Error('no mirror — the session never opened');
            withRuntime(rt, () => request(name, payload));
        },
        requests(): RequestFrame[] {
            return server.received.filter((e): e is RequestFrame => e.kind === 'request');
        },
    };
    client.start();
    for (let i = 0; i < 20 && client.state !== 'live'; i++) h.run(1);
    return h;
}

afterEach(() => clearRuntime());

describe('a client request goes to the authority', () => {
    it('sends one request frame per frame, stamped with the local tick', async () => {
        const h = await harness();
        h.ask('buy', { item: 'shield' });
        h.ask('ready');
        h.run(2);

        const sent = h.requests();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.requests).toStrictEqual([
            { name: 'buy', data: { item: 'shield' } },
            { name: 'ready' },
        ]);
        expect(sent[0]?.tick).toBeGreaterThan(0);
    });

    it('does NOT run an @onRequest handler in this process', async () => {
        LocalVault.asks = 0;
        const h = await harness();
        // Attached to the mirror's own Game, so a loopback dispatch would find it: the counter is the
        // whole assertion, and the ask still reaching the wire is what makes zero mean "sent", not
        // "dropped".
        h.client.mirror?.runtime.gameInstance.addScript(LocalVault as never);
        h.ask('buy', { item: 'shield' });
        h.run(2);

        expect(LocalVault.asks).toBe(0);
        expect(h.requests()).toHaveLength(1);
    });

    it('drops a payload field the wire cannot carry rather than failing the session', async () => {
        const h = await harness();
        // A reserved key would make the codec refuse the whole frame, and a function is a value no
        // wire delivers — either would throw out of `send` and end the session over a creator's typo.
        h.ask('buy', {
            item: 'shield',
            ['__proto__']: { polluted: true },
            callback: () => undefined,
            nested: { ok: 1, bad: new Map() },
        });
        h.run(2);

        expect(h.requests()[0]?.requests).toStrictEqual([
            { name: 'buy', data: { item: 'shield' } },
        ]);
        expect(h.client.state).toBe('live');
    });

    it('spreads a burst across frames rather than minting one the authority refuses whole', async () => {
        const h = await harness();
        // Creator code makes these in a loop — one per inventory item — where a human cannot make 17
        // clicks in a frame. A single over-cap frame is refused entire, so all 17 would be lost.
        for (let i = 0; i < MAX_REQUESTS_PER_FRAME + 1; i++) h.ask('sell', { slot: i });
        h.run(4);

        const sent = h.requests();
        for (const frame of sent) {
            expect(frame.requests.length).toBeLessThanOrEqual(MAX_REQUESTS_PER_FRAME);
        }
        expect(sent.flatMap((f) => f.requests.map((r) => r.data?.['slot']))).toStrictEqual(
            Array.from({ length: MAX_REQUESTS_PER_FRAME + 1 }, (_, i) => i),
        );
    });

    it('sends nothing while input is refused, since a stalled session can ask for nothing', async () => {
        const h = await harness();
        // A stall is the client's own judgement that the authority is not processing; a request held
        // through one would arrive stamped against a tick the server has long passed.
        h.client.lifecycle.to('stalled');
        h.ask('buy', { item: 'shield' });
        h.run(2);

        expect(h.requests()).toStrictEqual([]);
    });
});

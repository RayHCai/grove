// Every frame the client sends is held to the protocol's own narrowing: a frame the authority would
// refuse whole is one nobody sees fail, so each case here re-checks what left with that rule.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime, request, withRuntime } from '@platform/core';
import {
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_WIDGET_NAME_LENGTH,
    asClientEnvelope,
} from '@platform/protocol';
import type { InputFrame, InteractionFrame, RequestFrame } from '@platform/protocol';
import { createReadyNullRenderer } from '@platform/renderer/null';
import { loopbackPair } from '@platform/transport';
import type { Binding } from '../src/bindings.js';
import { GameClient } from '../src/client.js';
import { ManualFrameSource, ScriptedInputDevice } from '../src/input.js';
import { FakeServer } from './fake-server.js';

const TICK = 1 / 60;

interface Harness {
    client: GameClient;
    server: FakeServer;
    device: ScriptedInputDevice;
    run(n?: number): void;
    ask(name: string, payload?: Record<string, unknown>): void;
    sent<K extends 'input' | 'interaction' | 'request'>(
        kind: K,
    ): Array<
        K extends 'input' ? InputFrame : K extends 'interaction' ? InteractionFrame : RequestFrame
    >;
}

async function harness(bindings: readonly Binding[] = []): Promise<Harness> {
    const pair = loopbackPair({ latency: 1 });
    const server = new FakeServer(pair.server);
    const renderer = await createReadyNullRenderer({ design: { width: 800, height: 600 } });
    const frames = new ManualFrameSource();
    const device = new ScriptedInputDevice();
    let now = 0;

    const client = new GameClient({
        transport: pair.client,
        renderer,
        frames,
        device,
        clock: { nowSeconds: () => now },
        name: 'Ray',
        bindings,
        pump: () => pair.deliver(),
    });

    const h: Harness = {
        client,
        server,
        device,
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
            if (rt === undefined) throw new Error('no mirror: the session never opened');
            withRuntime(rt, () => request(name, payload));
        },
        sent(kind) {
            return server.received.filter((e) => e.kind === kind) as never;
        },
    };
    client.start();
    for (let i = 0; i < 20 && client.state !== 'live'; i++) h.run(1);
    return h;
}

/** What the authority would make of each frame the client sent: undefined is a refusal. */
function admitted(frames: readonly object[]): boolean[] {
    return frames.map((frame) => asClientEnvelope(frame) !== undefined);
}

afterEach(() => clearRuntime());

describe('interactions over the per-frame cap', () => {
    it('go out across frames, every one of which the authority admits', async () => {
        const h = await harness();
        const presses = MAX_INTERACTIONS_PER_FRAME + 4;
        for (let i = 0; i < presses; i++) h.client.pressWidget(`tile-${i}`);
        h.run(3);

        const frames = h.sent('interaction');
        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames.every((frame) => frame.events.length <= MAX_INTERACTIONS_PER_FRAME)).toBe(
            true,
        );
        expect(admitted(frames).every(Boolean)).toBe(true);
        expect(frames.flatMap((frame) => frame.events)).toHaveLength(presses);
        expect(h.client.stats().outboundRefused).toBe(0);
    });
});

describe('a press the authority would refuse its whole frame for', () => {
    it('is kept off the wire and counted, and the presses beside it still go', async () => {
        const h = await harness();
        h.client.pressWidget('w'.repeat(MAX_WIDGET_NAME_LENGTH + 1));
        h.client.pressWidget('play', 's'.repeat(MAX_WIDGET_NAME_LENGTH + 1));
        h.client.pressWidget('play');
        h.run(2);

        const events = h.sent('interaction').flatMap((frame) => frame.events);
        expect(events).toStrictEqual([{ kind: 'press', widget: 'play' }]);
        expect(admitted(h.sent('interaction')).every(Boolean)).toBe(true);
        expect(h.client.stats().outboundRefused).toBe(2);
    });
});

describe('a request the authority would refuse its whole frame for', () => {
    it('is kept off the wire and counted: a long name, or a payload past the node cap', async () => {
        const h = await harness();
        h.ask('n'.repeat(80));
        const wide: Record<string, number> = {};
        for (let i = 0; i <= MAX_REQUEST_PAYLOAD_NODES; i++) wide[`k${i}`] = i;
        h.ask('buy', wide);
        h.ask('ready');
        h.run(2);

        expect(h.sent('request').flatMap((frame) => frame.requests)).toStrictEqual([
            { name: 'ready' },
        ]);
        expect(admitted(h.sent('request')).every(Boolean)).toBe(true);
        expect(h.client.stats().outboundRefused).toBe(2);
    });
});

describe('input actions', () => {
    it('drop an action whose name the authority refuses, rather than every action in its frame', async () => {
        const long = 'a'.repeat(MAX_ACTION_NAME_LENGTH + 1);
        const h = await harness([
            { kind: 'button', code: 'keys:KeyW', action: 'jump' },
            { kind: 'button', code: 'keys:KeyQ', action: long },
        ]);
        h.device.emit({ kind: 'key', code: 'keys:KeyW', down: true });
        h.device.emit({ kind: 'key', code: 'keys:KeyQ', down: true });
        h.run(2);

        const actions = h.sent('input').flatMap((frame) => frame.actions);
        expect(actions.map((a) => a.action)).toStrictEqual(['jump']);
        expect(admitted(h.sent('input')).every(Boolean)).toBe(true);
        expect(h.client.stats().outboundRefused).toBe(1);
        // Not folded either: the client would otherwise predict an input the server never saw.
        expect(h.client.actions.held(long)).toBe(false);
    });

    it('cap one frame at the per-frame limit and fold only what was sent', async () => {
        const bindings: Binding[] = [];
        for (let i = 0; i <= MAX_ACTIONS_PER_FRAME; i++) {
            bindings.push({ kind: 'button', code: `keys:K${i}`, action: `act-${i}` });
        }
        const h = await harness(bindings);
        for (const binding of bindings) {
            if (binding.kind === 'button')
                h.device.emit({ kind: 'key', code: binding.code, down: true });
        }
        h.run(2);

        const frames = h.sent('input');
        expect(frames[0]?.actions).toHaveLength(MAX_ACTIONS_PER_FRAME);
        expect(admitted(frames).every(Boolean)).toBe(true);
        // The overflow is dropped, not carried: a press is an edge, and a late one is a different input.
        expect(frames.flatMap((frame) => frame.actions)).toHaveLength(MAX_ACTIONS_PER_FRAME);
        expect(h.client.stats().outboundRefused).toBe(1);
        expect(h.client.actions.held('act-0')).toBe(true);
        expect(h.client.actions.held(`act-${MAX_ACTIONS_PER_FRAME}`)).toBe(false);
    });
});

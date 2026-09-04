// The bounds on what one peer can buy with one frame, plus the two silent-failure paths.
//
// Every case here is a cost a hostile client could impose that no window and no token bucket saw,
// because they bound how MANY frames arrive rather than what one frame is allowed to contain.

import { describe, expect, it } from 'vitest';
import { templateId } from '@platform/project';
import type { Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import type { InputAction, Welcome } from '@platform/protocol';
import { Sim } from '../src/sim.js';
import { encodeStateValue } from '../src/replicate.js';
import {
    CONTROL_BUCKET_FRAMES,
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAMES,
    MAX_ACTION_NAME_LENGTH,
    MAX_STATE_DEPTH,
    MAX_UNJOINED_CONNECTIONS,
} from '../src/constants.js';
import { harness } from './harness.js';
import { Rules } from '../dist/testkit/fixtures.js';

function presses(count: number, name = (i: number) => `a${i}`): InputAction[] {
    return Array.from({ length: count }, (_, i) => ({ action: name(i), on: 'press' }) as const);
}

function nest(depth: number): object {
    let value: object = { leaf: 1 };
    for (let i = 0; i < depth; i++) value = { n: value };
    return value;
}

describe('what one frame is allowed to contain', () => {
    it('ignores a frame carrying more actions than the per-frame cap, and keeps the connection', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        peer.input(h.tick + 2, presses(MAX_ACTIONS_PER_FRAME + 1));
        h.pumpTicks(8);
        // Dropped at the narrowing, which holds no validated seq to resolve — so the ack stalls
        // exactly as it would on a frame that never arrived, until the abandonment rule releases it.
        expect(peer.lastState?.ackSeq).toBe(-1);

        peer.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(32);
        expect(peer.lastState?.ackSeq).toBe(1);
    });

    it('ignores a frame whose action name is longer than the cap', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        peer.input(h.tick + 2, [{ action: 'x'.repeat(MAX_ACTION_NAME_LENGTH + 1), on: 'press' }]);
        h.pumpTicks(8);
        expect(peer.lastState?.ackSeq).toBe(-1);
    });

    it('stops folding new action names once the per-connection key space is full', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        // Three frames of distinct names, well past the cap: every held name costs a synthesized
        // `hold` dispatch on every later tick, so the key space is the thing that has to be bounded.
        const at = h.tick + 2;
        for (let batch = 0; batch < 3; batch++) {
            peer.input(
                at,
                presses(30, (i) => `a${batch}_${i}`),
            );
        }
        h.pumpTicks(8);

        const conn = h.sim.sessions[0];
        expect(conn?.actions.heldActions().length).toBe(MAX_ACTION_NAMES);
    });

    it('refuses a non-finite axis sample, which core would write straight into its transform store', () => {
        const h = harness({ config: { simRate: 60, sendRate: 20, gameScripts: [Rules] } });
        const peer = h.joined('a');

        peer.input(h.tick + 2, [{ action: 'moveX', on: 'hold', value: Number.POSITIVE_INFINITY }]);
        h.pumpTicks(12);

        const session = h.sim.sessions[0];
        expect(session?.actions.axis('moveX')).toBe(0);
        const avatar = session?.player?.avatar;
        expect(Number.isFinite(h.sim.runtime.transforms.posX(avatar!.entityId))).toBe(true);
    });
});

describe('control frames draw on their own bucket', () => {
    it('answers a time-sync flood at most bucket-deep instead of once per frame', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        for (let i = 0; i < 24; i++) peer.timeSync(i);
        h.pumpTicks(4);

        expect(peer.timeSyncReplies.length).toBeGreaterThan(0);
        expect(peer.timeSyncReplies.length).toBeLessThanOrEqual(CONTROL_BUCKET_FRAMES);
    });

    it('never refuses a client keeping the ordinary two-second sync cadence', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        for (let i = 0; i < 5; i++) {
            h.pumpTicks(120);
            peer.timeSync(i);
            h.pumpTicks(2);
        }

        expect(peer.timeSyncReplies).toHaveLength(5);
    });

    it('bounds resync snapshots, which are the most expensive thing a frame can ask for', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        for (let i = 0; i < 24; i++) peer.join('a');
        h.pumpTicks(16);

        const welcomes = peer.received.filter((e): e is Welcome => e.kind === 'welcome');
        expect(welcomes.length).toBeGreaterThan(0);
        expect(welcomes.length).toBeLessThanOrEqual(CONTROL_BUCKET_FRAMES);
    });
});

describe('anything the state encoder accepts, the codec accepts', () => {
    it('drops a value nested past the cap rather than letting encode abort the send', () => {
        expect(encodeStateValue(nest(MAX_STATE_DEPTH))).toBeUndefined();

        // The deepest envelope a state value rides is the join snapshot's, so the margin has to hold
        // there: a value the encoder passes and the codec refuses throws out of the fan-out and takes
        // every connection's send with it.
        const accepted = encodeStateValue(nest(MAX_STATE_DEPTH - 1));
        expect(accepted).toBeDefined();
        const welcome = {
            kind: 'welcome',
            snapshot: { state: [{ host: { kind: 'game' }, field: 'deep', value: accepted }] },
        };
        expect(() => jsonCodec.encode(welcome as unknown as Message)).not.toThrow();
    });
});

describe('shutdown', () => {
    it('closes every connection, releases their players, and stops stepping', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);
        const tickAtClose = h.tick;

        h.close();

        // The close path is run directly rather than left to each transport's onClose, which would need
        // a delivery that is never going to come.
        expect(h.sim.sessions).toHaveLength(0);
        expect(h.sim.runtime.playerManager?.players).toHaveLength(0);

        h.pumpTicks(8);
        expect(h.tick).toBe(tickAtClose);
    });

    it('is idempotent, and refuses a connection offered afterwards', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.close();
        h.close();

        h.connect();
        h.pumpTicks(1);
        expect(h.lastAcceptId).toBeNull();
        expect(h.sim.sessions).toHaveLength(0);
    });

    it('orders a refusal at the unjoined cap closed, rather than keeping a session for it', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        for (let i = 0; i < MAX_UNJOINED_CONNECTIONS; i++) h.connect();
        h.pumpTicks(1);
        expect(h.lastAcceptId).not.toBeNull();

        h.connect();
        h.pumpTicks(1);
        expect(h.lastAcceptId).toBeNull();
        expect(h.sim.sessions).toHaveLength(MAX_UNJOINED_CONNECTIONS);
    });
});

describe('the world is built before anything is admitted', () => {
    it('is booted by the time any caller holds it, so `accept` never sees a half-world', () => {
        // The whole boot is the constructor — registry, Game scripts, scene, `@onStart` to its
        // first await — and `booted` is set after all of it. There is no window a caller can
        // observe, which is the guarantee: a joiner's snapshot is its entire baseline, and no
        // later delta repairs one taken of a world still being assembled.
        const server = new Sim({
            config: {
                gameScripts: [Rules],
                templates: [{ id: templateId('probe'), scripts: [], children: [] }],
            },
        });
        expect(server.booted).toBe(true);
        server.close();
    });

    it('builds the placed world before any Game @onStart could look for it', () => {
        const h = harness({
            config: {
                gameScripts: [Rules],
                templates: [{ id: templateId('crate'), scripts: [], children: [] }],
                entities: [
                    {
                        id: 'e1',
                        template: templateId('crate'),
                        parent: null,
                        transform: { x: 7 },
                        tags: ['placed'],
                        scripts: [],
                    },
                ],
            },
        });
        const placed = h.sim.runtime.gameInstance!.find({ tag: 'placed' });
        expect(placed).toHaveLength(1);
        expect(placed[0]?.position.x).toBe(7);
    });
});

describe('a misconfigured server says so instead of going quiet', () => {
    it('refuses a simRate the accumulator could never reach', () => {
        expect(() => new Sim({ config: { simRate: 0 } })).toThrow(/simRate/);
        expect(() => new Sim({ config: { sendRate: Number.NaN } })).toThrow(/sendRate/);
        expect(() => new Sim({ config: { maxPlayers: 0 } })).toThrow(/maxPlayers/);
    });

    it('reports the live simRate after a rate change, not the load-time one', () => {
        const h = harness({ config: { gameScripts: [Rules], simRate: 60 } });
        h.joined('a');
        h.sim.setSimRate(30);
        expect(h.sim.config.simRate).toBe(30);
        expect(h.sim.runtime.simRate).toBe(30);
    });
});

// The bounds on what one peer can buy with one frame, plus the two silent-failure paths.
//
// Every case here is a cost a hostile client could impose that no window and no token bucket saw,
// because they bound how MANY frames arrive rather than what one frame is allowed to contain.

import { describe, expect, it } from 'vitest';
import type { EncodedFrame, Message, Transport } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { InputAction, Welcome } from '@platform/protocol';
import { GameServer } from '../src/server.js';
import { encodeStateValue } from '../src/broadcast.js';
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

/**
 * A transport with no codec in the way, so a test can hand the server a value `jsonCodec` would have
 * refused on the way out — which is what a binary codec or a hostile socket can do.
 */
class DirectTransport implements Transport {
    readonly sent: unknown[] = [];
    #onMessage: ((message: Message) => void) | undefined;
    #closed = false;

    send(message: Message): void {
        if (!this.#closed) this.sent.push(message);
    }

    sendEncoded(frame: EncodedFrame): void {
        if (!this.#closed) this.sent.push(frame);
    }

    onMessage(handler: (message: Message) => void): () => void {
        this.#onMessage = handler;
        return () => {
            this.#onMessage = undefined;
        };
    }

    /** Registered and never fired: these cases exercise the inbound narrowing, not the close path. */
    onClose(): () => void {
        return () => undefined;
    }

    close(): void {
        this.#closed = true;
    }

    receive(message: unknown): void {
        this.#onMessage?.(message as Message);
    }
}

describe('§4.3 — what one frame is allowed to contain', () => {
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

        const conn = h.server.connections[0];
        expect(conn?.actions.heldActions().length).toBe(MAX_ACTION_NAMES);
    });

    it('refuses a non-finite axis sample, which core would write straight into its transform store', () => {
        const server = new GameServer({
            config: { simRate: 60, sendRate: 20, gameScripts: [Rules] },
        });
        const transport = new DirectTransport();
        server.accept(transport);
        transport.receive({
            kind: 'join-request',
            protocolVersion: PROTOCOL_VERSION,
            name: 'a',
            clientSentMs: 1,
            projectId: '',
            projectHash: '',
            bundleHash: '',
        });
        for (let i = 1; i <= 8; i++) server.pump(i / 60);

        const tick = server.runtime.tick;
        transport.receive({
            kind: 'input',
            tick: tick + 2,
            seq: 0,
            actions: [{ action: 'moveX', on: 'hold', value: Number.POSITIVE_INFINITY }],
        });
        for (let i = 9; i <= 20; i++) server.pump(i / 60);

        const conn = server.connections[0];
        expect(conn?.actions.axis('moveX')).toBe(0);
        const avatar = conn?.player?.avatar;
        expect(Number.isFinite(server.runtime.transforms.posX(avatar!.entityId))).toBe(true);
    });
});

describe('§4.3 — control frames draw on their own bucket', () => {
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

describe('§5.3 — anything the state encoder accepts, the codec accepts', () => {
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

describe('§7 — shutdown', () => {
    it('closes every connection, releases their players, and stops stepping', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);
        const tickAtClose = h.tick;

        h.server.close();

        // The close path is run directly rather than left to each transport's onClose, which would need
        // a delivery that is never going to come.
        expect(h.server.connections).toHaveLength(0);
        expect(h.server.runtime.playerManager?.players).toHaveLength(0);

        h.pumpTicks(8);
        expect(h.tick).toBe(tickAtClose);
    });

    it('is idempotent, refuses a later accept, and refuses start()', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.server.close();
        h.server.close();

        h.connect();
        expect(h.lastAcceptId).toBeNull();
        expect(() => h.server.start()).toThrow(/closed/);
    });

    it('reports a refusal at the unjoined cap as null, not as an id for a socket it just closed', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        for (let i = 0; i < MAX_UNJOINED_CONNECTIONS; i++) h.connect();
        h.pumpTicks(1);
        expect(h.lastAcceptId).not.toBeNull();

        h.connect();
        expect(h.lastAcceptId).toBeNull();
        expect(h.server.connections).toHaveLength(MAX_UNJOINED_CONNECTIONS);
    });
});

describe('§3.4, §6.4 — a misconfigured server says so instead of going quiet', () => {
    it('refuses a simRate the accumulator could never reach', () => {
        expect(() => new GameServer({ config: { simRate: 0 } })).toThrow(/simRate/);
        expect(() => new GameServer({ config: { sendRate: Number.NaN } })).toThrow(/sendRate/);
        expect(() => new GameServer({ config: { maxPlayers: 0 } })).toThrow(/maxPlayers/);
    });

    it('refuses start() with no injected timer, rather than self-driving nothing', () => {
        const server = new GameServer({ config: { gameScripts: [Rules] } });
        expect(() => server.start()).toThrow(/TimerSource/);
    });

    it('reports the live simRate after a rate change, not the load-time one', () => {
        const h = harness({ config: { gameScripts: [Rules], simRate: 60 } });
        h.joined('a');
        h.server.setSimRate(30);
        expect(h.server.config.simRate).toBe(30);
        expect(h.server.runtime.simRate).toBe(30);
    });
});

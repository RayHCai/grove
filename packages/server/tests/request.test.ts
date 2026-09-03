// The request arm: the one client → server path with authority behind it. What reaches an
// `@onRequest` handler here, and what the untrusted boundary refuses first. Fixtures are compiled
// by the build.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { Rules, Vault } from '../dist/testkit/fixtures.js';
import {
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_NAME_LENGTH,
    MAX_REQUEST_PAYLOAD_NODES,
} from '../src/constants.js';
import { harness } from './harness.js';
import type { Harness } from './harness.js';

afterEach(() => {
    clearRuntime();
});

function vault(h: Harness): Vault {
    return [...h.server.runtime.instances.forHost('game')].find((i) => i.className === 'Vault')
        ?.instance as Vault;
}

describe('a request runs on the authority and nowhere else', () => {
    it('dispatches @onRequest, with the player from the connection and the payload from the frame', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        peer.request(h.tick + 1, [{ name: 'buy', data: { item: 'shield' } }]);
        h.pumpTicks(2);

        // `ctx.player` is engine-supplied from the connection; no frame field names a player.
        expect(vault(h).asks).toStrictEqual(['c1:shield']);
        // The handler's authoritative write landed, which is the whole point of the arm existing.
        expect(vault(h).coins).toBe(1);
    });

    it('carries a payload-free call, so `data` absent means an empty ctx.data rather than none', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        peer.request(h.tick + 1, [{ name: 'buy' }]);
        h.pumpTicks(2);

        // The handler ran and refused it on its own validation, which is the contract: ctx.data is
        // always an object, so a handler never null-checks it.
        expect(vault(h).asks).toStrictEqual([]);
        expect(vault(h).coins).toBe(0);
    });

    it('dispatches nothing for a name no handler declares', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        peer.request(h.tick + 1, [{ name: 'sell', data: { item: 'shield' } }]);
        h.pumpTicks(2);

        expect(vault(h).asks).toStrictEqual([]);
    });

    it('drops a request that arrived before the join — identity comes from the connection', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.connect();
        peer.request(1, [{ name: 'buy', data: { item: 'shield' } }]);
        h.pumpTicks(3);

        expect(vault(h).asks).toStrictEqual([]);
    });

    it('dispatches in the order the player made them, one per queued call', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        peer.request(h.tick + 1, [
            { name: 'buy', data: { item: 'shield' } },
            { name: 'buy', data: { item: 'sword' } },
        ]);
        h.pumpTicks(2);

        expect(vault(h).asks).toStrictEqual(['c1:shield', 'c1:sword']);
    });
});

describe('the untrusted boundary bounds one request frame before it walks it', () => {
    it('refuses a frame carrying more than MAX_REQUESTS_PER_FRAME calls, whole', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        peer.request(
            h.tick + 1,
            Array.from({ length: MAX_REQUESTS_PER_FRAME + 1 }, () => ({
                name: 'buy',
                data: { item: 'shield' },
            })),
        );
        h.pumpTicks(2);

        // Whole, not truncated: the count is peer-chosen and the validation itself is linear in it.
        expect(vault(h).asks).toStrictEqual([]);
    });

    it('refuses a frame whose request name is empty or over the length cap', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        // Each frame carries one call that would otherwise land, so the assertion reads the refusal
        // rather than a name no handler happened to declare.
        const good = { name: 'buy', data: { item: 'shield' } };
        peer.request(h.tick + 1, [good, { name: '' }]);
        peer.request(h.tick + 1, [good, { name: 'x'.repeat(MAX_REQUEST_NAME_LENGTH + 1) }]);
        h.pumpTicks(2);

        expect(vault(h).asks).toStrictEqual([]);
        expect(h.server.connections).toHaveLength(1);
    });

    it('refuses a payload holding more than MAX_REQUEST_PAYLOAD_NODES values, whole', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');

        const wide: Record<string, string | number> = { item: 'shield' };
        for (let i = 0; i <= MAX_REQUEST_PAYLOAD_NODES; i++) wide[`k${i}`] = i;
        peer.request(h.tick + 1, [{ name: 'buy', data: wide }]);

        // Counted over the whole graph, not per level: a payload with few fields, each holding a
        // short array, spends the same budget and would otherwise slip a per-level cap.
        const spread: Record<string, number[]> = {};
        for (let i = 0; i < 20; i++) spread[`k${i}`] = Array.from({ length: 20 }, (_, n) => n);
        peer.request(h.tick + 1, [{ name: 'buy', data: { item: 'shield', spread } }]);
        h.pumpTicks(2);

        expect(vault(h).asks).toStrictEqual([]);
        expect(h.server.connections).toHaveLength(1);
    });

    it('ignores a frame it cannot name without ending the session', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');
        const good = { name: 'buy', data: { item: 'shield' } };

        peer.raw({ kind: 'request', tick: 1, requests: [good, { name: 7 }] });
        peer.raw({ kind: 'request', tick: 1.5, requests: [good] });
        peer.raw({ kind: 'request', tick: 1 });
        // `data` is a map of fields, so an array or a scalar is not one.
        peer.raw({ kind: 'request', tick: 1, requests: [good, { name: 'buy', data: ['x'] }] });
        peer.raw({ kind: 'request', tick: 1, requests: [good, { name: 'buy', data: 'x' }] });
        h.pumpTicks(2);

        expect(vault(h).asks).toStrictEqual([]);
        expect(h.server.connections).toHaveLength(1);
    });

    it('spends an input token, so it opens no second unmetered channel', () => {
        const h = harness({ config: { gameScripts: [Rules, Vault] } });
        const peer = h.joined('a');
        const before = h.server.connections[0]!.admission.rateRefusals;

        // Past the bucket's depth in one wake: a request is the same shape of cost as an input
        // frame, and one bucket is what keeps a peer's TOTAL per-tick work bounded.
        for (let i = 0; i < 40; i++) {
            peer.request(h.tick + 1, [{ name: 'buy', data: { item: 'shield' } }]);
        }
        h.pumpTicks(2);

        expect(h.server.connections[0]!.admission.rateRefusals).toBeGreaterThan(before);
    });
});

// The live render manifest (DESIGN §5.1): what a joiner is handed, and what connected peers are
// owed when a template comes into use after they joined.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import type { ManifestUpdate, RenderManifest } from '@platform/protocol';
import { Rules } from '../dist/testkit/fixtures.js';
import { ManifestStore } from '../src/manifest.js';
import { harness } from './harness.js';
import type { Peer } from './harness.js';

afterEach(() => {
    clearRuntime();
});

const coin: RenderManifest = {
    assets: [{ key: 'coin', kind: 'texture', url: '/coin.png' }],
    templates: [{ template: 'coin', kind: 'sprite', texture: 'coin' }],
};

function updates(peer: Peer): ManifestUpdate[] {
    return peer.received.filter((e): e is ManifestUpdate => e.kind === 'manifest');
}

describe('ManifestStore', () => {
    it('holds the boot manifest without queueing it — nobody is behind at boot', () => {
        const store = new ManifestStore(coin);
        expect(store.snapshot().templates).toHaveLength(1);
        expect(store.drain()).toBeNull();
    });

    it('queues only what is genuinely new, so a second declaration costs nothing', () => {
        const store = new ManifestStore();
        store.declare(coin);
        expect(store.drain()?.templates.map((t) => t.template)).toEqual(['coin']);

        store.declare(coin);
        expect(store.drain()).toBeNull();
        // Held once, not twice: a client merging a duplicate would just overwrite itself, but the
        // envelope is wasted bandwidth on every peer.
        expect(store.snapshot().templates).toHaveLength(1);
    });

    it('drains once — the additions belong to one send', () => {
        const store = new ManifestStore();
        store.declare(coin);
        expect(store.drain()).not.toBeNull();
        expect(store.drain()).toBeNull();
    });

    it('grows the join payload too, so the two paths cannot disagree', () => {
        const store = new ManifestStore(coin);
        store.declare({
            assets: [],
            templates: [{ template: 'gem', kind: 'sprite', texture: 'coin' }],
        });
        expect(store.snapshot().templates.map((t) => t.template)).toEqual(['coin', 'gem']);
        expect(store.hasTemplate('gem')).toBe(true);
    });
});

describe('§5.1 — a template first used mid-session reaches the clients already connected', () => {
    it('sends the addition to a peer that joined before it existed', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);
        expect(updates(peer)).toHaveLength(0);

        h.server.declareVisuals(coin);
        h.pumpTicks(6);

        const sent = updates(peer);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.visuals.templates.map((t) => t.template)).toEqual(['coin']);
        expect(sent[0]?.visuals.assets.map((a) => a.key)).toEqual(['coin']);
    });

    it('sends it AHEAD of the state envelope that first spawns one', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        h.server.declareVisuals(coin);
        h.server.runtime.entityManager.spawn('coin', 0, 0);
        h.pumpTicks(6);

        // Order is the whole requirement: a node created against a table that does not hold the
        // template draws the placeholder and keeps it for the rest of the session.
        const manifestAt = peer.received.findIndex((e) => e.kind === 'manifest');
        const spawnAt = peer.received.findIndex(
            (e) => e.kind === 'state' && e.structural.some((op) => op.kind === 'spawn'),
        );
        expect(manifestAt).toBeGreaterThanOrEqual(0);
        expect(spawnAt).toBeGreaterThan(manifestAt);
    });

    it('says nothing when a declaration adds nothing', () => {
        const h = harness({ config: { visuals: coin, gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);

        h.server.declareVisuals(coin);
        h.pumpTicks(6);
        expect(updates(peer)).toHaveLength(0);
    });

    it('gives a later joiner the same template in its Welcome, not as a delta', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        h.settle([first]);
        h.server.declareVisuals(coin);

        const second = h.joined('b');
        expect(second.welcome?.visuals.templates.map((t) => t.template)).toEqual(['coin']);
        // The snapshot already carries it, so the delta would be telling it twice.
        expect(updates(second)).toHaveLength(0);
    });

    it('defines the asset on core’s table too, so `assets.get` answers for it', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.joined('a');
        expect(h.server.runtime.assets?.get('coin')).toBeNull();

        h.server.declareVisuals(coin);
        expect(h.server.runtime.assets?.get('coin')?.key).toBe('coin');
    });
});

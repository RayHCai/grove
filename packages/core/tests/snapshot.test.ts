// Snapshot/restore and the determinism round-trip. Two runs of one
// input sequence must produce byte-identical state, and restore(snapshot(t)) + replay must
// reproduce it. Also: the registry-coverage test — every store declares a scoping mode.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { bounds } from '@platform/math';

afterEach(() => clearRuntime());

describe('snapshot / restore', () => {
    it('is a value, not a view — a later tick does not mutate a snapshot', () => {
        const rt = loadGame({ bounds: bounds(-500, 500, 500, -500) });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 10, 20);
        const snap = loop.snapshot();
        e.setPosition(999, 999);
        loop.restore(snap);
        expect(e.position).toEqual({ x: 10, y: 20, z: 0 });
    });

    it('round-trips transform + tag + prng state bit for bit', () => {
        const rt = loadGame({ bounds: bounds(-500, 500, 500, -500) });
        const loop = new Loop(rt);
        const a = rt.wired.gameInstance.spawn('crate', 1, 2).tag('x');
        rt.wired.random.seed(42);
        rt.wired.random.between(0, 1000); // advance the stream a bit
        const snap = loop.snapshot();

        // the value the stream WOULD draw next, from the captured position
        const expectedNext = rt.wired.random.between(0, 1000);

        // mutate everything, including drawing more from the PRNG
        a.setPosition(50, 60);
        a.untag('x').tag('y');
        rt.wired.random.between(0, 1000);
        rt.wired.random.between(0, 1000);

        loop.restore(snap);
        expect(a.position).toEqual({ x: 1, y: 2, z: 0 });
        expect(a.hasTag('x')).toBe(true);
        expect(a.hasTag('y')).toBe(false);
        // the PRNG resumed from the captured position: the next draw matches
        expect(rt.wired.random.between(0, 1000)).toBe(expectedNext);
    });

    it('two runs of one input sequence produce identical state', () => {
        expect(deterministicRun()).toEqual(deterministicRun());
    });
});

/** One scripted run over a seeded PRNG — the determinism harness's unit. */
function deterministicRun(): { x: number; y: number; z: number } {
    const rt = loadGame({ bounds: bounds(-500, 500, 500, -500) });
    rt.wired.random.seed(7);
    const e = rt.wired.gameInstance.spawn('crate', 0, 0);
    for (let t = 1; t <= 60; t++) {
        e.moveBy(rt.wired.random.between(-1, 1), rt.wired.random.between(-1, 1));
        new Loop(rt).step(t);
    }
    const pos = { x: e.position.x, y: e.position.y, z: e.position.z };
    clearRuntime();
    return pos;
}

describe('registry coverage', () => {
    it('registers exactly these stores, in capture order', () => {
        // Order is capture and apply order, so it is part of the contract rather than an artifact
        // of how the constructor happens to read. A `toContain` per name pins neither.
        const rt = loadGame();
        expect(rt.registry.stores.map((s) => s.storeName)).toStrictEqual([
            'entities',
            'transforms',
            'tags',
            'prng',
            'breaker',
            'timers',
        ]);
    });

    it('declares the scoping mode each store actually needs', () => {
        // The exact map, not merely "some legal mode": a `whole` store silently becoming `filtered`
        // is how a scoped rewind starts restoring a partial PRNG stream, and every symptom of that
        // shows up ticks later as a desync with nothing pointing back here.
        const rt = loadGame();
        const modes = Object.fromEntries(rt.registry.stores.map((s) => [s.storeName, s.scopeMode]));
        expect(modes).toStrictEqual({
            // The scope names entities, so these three narrow to the slots it holds.
            entities: 'whole', // …except this one: a subset still needs every slot's generation,
            transforms: 'filtered', //  or a handle the scope excluded stops reading as stale.
            tags: 'filtered',
            timers: 'filtered', // by owning host scope rather than by slot
            prng: 'whole', // one interleaved stream, with no per-entity subsequence to take
            breaker: 'whole', // keyed by instance id, which no set of entity ids narrows
        });
    });
});

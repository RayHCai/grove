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
        const e = rt.gameInstance!.spawn('crate', 10, 20);
        const snap = loop.snapshot();
        e.setPosition(999, 999);
        loop.restore(snap);
        expect(e.position).toEqual({ x: 10, y: 20, z: 0 });
    });

    it('round-trips transform + tag + prng state bit for bit', () => {
        const rt = loadGame({ bounds: bounds(-500, 500, 500, -500) });
        const loop = new Loop(rt);
        const a = rt.gameInstance!.spawn('crate', 1, 2).tag('x');
        rt.random!.seed(42);
        rt.random!.between(0, 1000); // advance the stream a bit
        const snap = loop.snapshot();

        // the value the stream WOULD draw next, from the captured position
        const expectedNext = rt.random!.between(0, 1000);

        // mutate everything, including drawing more from the PRNG
        a.setPosition(50, 60);
        a.untag('x').tag('y');
        rt.random!.between(0, 1000);
        rt.random!.between(0, 1000);

        loop.restore(snap);
        expect(a.position).toEqual({ x: 1, y: 2, z: 0 });
        expect(a.hasTag('x')).toBe(true);
        expect(a.hasTag('y')).toBe(false);
        // the PRNG resumed from the captured position: the next draw matches
        expect(rt.random!.between(0, 1000)).toBe(expectedNext);
    });

    it('two runs of one input sequence produce identical state', () => {
        expect(deterministicRun()).toEqual(deterministicRun());
    });
});

/** One scripted run over a seeded PRNG — the determinism harness's unit. */
function deterministicRun(): { x: number; y: number; z: number } {
    const rt = loadGame({ bounds: bounds(-500, 500, 500, -500) });
    rt.random!.seed(7);
    const e = rt.gameInstance!.spawn('crate', 0, 0);
    for (let t = 1; t <= 60; t++) {
        e.moveBy(rt.random!.between(-1, 1), rt.random!.between(-1, 1));
        new Loop(rt).step(t);
    }
    const pos = { x: e.position.x, y: e.position.y, z: e.position.z };
    clearRuntime();
    return pos;
}

describe('registry coverage', () => {
    it('every registered store declares a scoping mode with no default', () => {
        const rt = loadGame();
        for (const store of rt.registry.stores) {
            expect(store.storeName).toBeTruthy();
            expect(['filtered', 'whole', 'derived']).toContain(store.scopeMode);
        }
    });

    it('registers the load-bearing stores including the PRNG', () => {
        const rt = loadGame();
        const names = rt.registry.stores.map((s) => s.storeName);
        expect(names).toContain('prng'); // the easiest to miss
        expect(names).toContain('transforms');
        expect(names).toContain('entities');
        expect(names).toContain('tags');
        expect(names).toContain('breaker');
        expect(names).toContain('timers');
    });
});

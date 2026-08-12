// A historical query reads a past capture and leaves the live simulation untouched: no step,
// no invocation swept, no channel marked.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { LagRing } from '../src/runtime/lag-ring.js';
import { MAX_REWIND_MS } from '../src/config.js';
import { bounds } from '@platform/math';

afterEach(() => clearRuntime());

describe('lag ring', () => {
    it('sizes to roughly MAX_REWIND_MS at the sim rate', () => {
        const rt = loadGame({ simRate: 60 });
        const ring = new LagRing(rt.transforms, rt.entities, 60);
        expect(ring.depth).toBe(Math.ceil((60 * MAX_REWIND_MS) / 1000));
    });

    it('a capture answers in real EntityIds, so a historical hit resolves to the right entity', () => {
        const rt = loadGame({ simRate: 60, bounds: bounds(-1000, 1000, 1000, -1000) });
        const loop = new Loop(rt);
        const crate = rt.gameInstance!.spawn('crate', 0, 0);
        loop.step(1);

        const hits = rt.lagRing!.broadphaseAt(1, () => 0)!.near(0, 0, 5);
        expect(hits).toContain(crate.entityId);
        expect(rt.entities.exists(hits[0]!)).toBe(true);
    });

    it('captures a past frame and answers overlaps against it, live world untouched', () => {
        const rt = loadGame({ simRate: 60, bounds: bounds(-1000, 1000, 1000, -1000) });
        const loop = new Loop(rt);

        // Tick 1: an entity sits at the origin; the ring captures it there.
        const shooter = rt.gameInstance!.spawn('crate', 0, 0);
        loop.step(1);

        // Ticks 2-3: it moves far away in the live world.
        shooter.setPosition(800, 0);
        loop.step(2);
        loop.step(3);

        // A query 'as seen' near the origin finds the past position; a live query does not.
        const pastBp = rt.lagRing!.broadphaseAt(1, () => 0);
        expect(pastBp).not.toBeNull();
        const pastHits = pastBp!.near(0, 0, 5);
        const liveHits = rt.broadphase!.near(0, 0, 5);

        expect(pastHits.length).toBeGreaterThanOrEqual(1); // it was here at tick 1
        expect(liveHits.length).toBe(0); // it is not here now

        // The live world is untouched: its position is still the moved one.
        expect(shooter.position.x).toBe(800);
    });

    it('a historical query marks no replication channel', () => {
        const rt = loadGame({ simRate: 60, bounds: bounds(-1000, 1000, 1000, -1000) });
        const loop = new Loop(rt);
        rt.gameInstance!.spawn('crate', 0, 0);
        loop.step(1);
        rt.channels.drainStructural(); // clear the spawn mark
        rt.transforms.consumeDirty(); // clear the spawn-time transform mark

        rt.lagRing!.broadphaseAt(1, () => 0)?.near(0, 0, 100);

        // A historical query reads a buffer and marks nothing.
        expect(rt.channels.structuralCount).toBe(0);
        expect(rt.channels.stateCount).toBe(0);
        expect(rt.transforms.consumeDirty()).toHaveLength(0);
    });
});

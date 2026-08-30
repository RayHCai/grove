// A scoped snapshot is a partial capture, so restoring one must leave every entity it did not
// capture exactly as it was — the client rolls back its own simulated set while remote entities
// keep the positions replication just gave them.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { bounds } from '@platform/math';

afterEach(() => clearRuntime());

const world = () => loadGame({ bounds: bounds(-5000, 5000, 5000, -5000) });

describe('scoped snapshot', () => {
    it('restores in-scope transforms and leaves out-of-scope ones untouched', () => {
        const rt = world();
        const loop = new Loop(rt);
        const mine = rt.wired.gameInstance.spawn('crate', 10, 10);
        const theirs = rt.wired.gameInstance.spawn('crate', -900, -900);

        const snap = loop.snapshot(new Set([mine.entityId]));
        mine.setPosition(11, 11);
        theirs.setPosition(-800, -800);
        loop.restore(snap);

        expect(mine.position).toEqual({ x: 10, y: 10, z: 0 });
        // Not (0, 0): a scoped apply that wrote the whole range teleported every other entity
        // to the buffer's untouched zeros.
        expect(theirs.position).toEqual({ x: -800, y: -800, z: 0 });
    });

    it('captures every in-scope slot even when the buffer starts smaller than the world', () => {
        const rt = world();
        const loop = new Loop(rt);
        // Past the 64-slot initial buffer, so the scoped branch has to grow it.
        const spawned = Array.from({ length: 80 }, (_, i) =>
            rt.wired.gameInstance.spawn('crate', i, 0),
        );
        const far = spawned[79]!;

        const snap = loop.snapshot(new Set([far.entityId]));
        far.setPosition(-1234, -1234);
        loop.restore(snap);

        expect(far.position).toEqual({ x: 79, y: 0, z: 0 });
    });

    it('restores in-scope tags without dropping the tags of entities outside it', () => {
        const rt = world();
        const loop = new Loop(rt);
        const mine = rt.wired.gameInstance.spawn('crate', 0, 0).tag('mine');
        const theirs = rt.wired.gameInstance.spawn('crate', 50, 50).tag('theirs');

        const snap = loop.snapshot(new Set([mine.entityId]));
        mine.untag('mine').tag('changed');
        loop.restore(snap);

        expect(mine.hasTag('mine')).toBe(true);
        expect(mine.hasTag('changed')).toBe(false);
        expect(theirs.hasTag('theirs')).toBe(true);
    });

    it('drops an in-scope tag added after the capture', () => {
        const rt = world();
        const loop = new Loop(rt);
        const mine = rt.wired.gameInstance.spawn('crate', 0, 0);

        const snap = loop.snapshot(new Set([mine.entityId]));
        mine.tag('predicted');
        loop.restore(snap);

        expect(mine.hasTag('predicted')).toBe(false);
    });

    it('keeps a timer owned by a host outside the scope', () => {
        const rt = world();
        const loop = new Loop(rt);
        const mine = rt.wired.gameInstance.spawn('crate', 0, 0);
        const theirs = rt.wired.gameInstance.spawn('crate', 1, 1);

        let theirsFired = 0;
        rt.timers.every(1, rt.hosts.scopeForEntity(theirs.entityId as unknown as number), () => {
            theirsFired++;
        });
        rt.timers.every(1, rt.hosts.scopeForEntity(mine.entityId as unknown as number), () => {});
        expect(rt.timers.pendingCount).toBe(2);

        loop.restore(loop.snapshot(new Set([mine.entityId])));

        // Both survive: clearing the heap cancelled the timer the capture never looked at.
        expect(rt.timers.pendingCount).toBe(2);
        for (let t = 1; t <= 60; t++) loop.step(t);
        expect(theirsFired).toBe(1);
    });

    it('a whole snapshot still replaces everything', () => {
        const rt = world();
        const loop = new Loop(rt);
        const a = rt.wired.gameInstance.spawn('crate', 1, 1);
        const b = rt.wired.gameInstance.spawn('crate', 2, 2);

        const snap = loop.snapshot();
        a.setPosition(90, 90);
        b.setPosition(91, 91);
        loop.restore(snap);

        expect(a.position).toEqual({ x: 1, y: 1, z: 0 });
        expect(b.position).toEqual({ x: 2, y: 2, z: 0 });
    });
});

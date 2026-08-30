// Entity destroy cascade and getTouching semantics.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { bounds } from '@platform/math';

afterEach(() => clearRuntime());

describe('destroy', () => {
    it('flips alive immediately but defers teardown to the drain', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0).tag('box');
        e.destroy();
        expect(e.alive).toBe(false); // logical-now
        // still findable until the drain runs
        expect(rt.wired.gameInstance.find({ tag: 'box' }).length).toBe(1);

        rt.entityManager.drainDestroyed();
        expect(rt.wired.gameInstance.find({ tag: 'box' }).length).toBe(0); // torn down
    });

    it('cascades to children — the whole subtree flips alive false', () => {
        const rt = loadGame();
        const parent = rt.wired.gameInstance.spawn('crate', 0, 0);
        const child = rt.wired.gameInstance.spawn('crate', 0, 0);
        const grandchild = rt.wired.gameInstance.spawn('crate', 0, 0);
        child.attachTo(parent);
        grandchild.attachTo(child);

        parent.destroy();
        expect(parent.alive).toBe(false);
        expect(child.alive).toBe(false);
        expect(grandchild.alive).toBe(false);
    });

    it('a stale handle is a no-op, not a crash', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.destroy();
        rt.entityManager.drainDestroyed();
        // e now names a freed slot
        expect(e.alive).toBe(false);
        expect(() => e.setPosition(5, 5)).not.toThrow();
        expect(() => e.tag('x')).not.toThrow();
    });
});

describe('getTouching', () => {
    it('returns an empty array (never null) for an entity with no collider', () => {
        const rt = loadGame({ bounds: bounds(-100, 100, 100, -100) });
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.wired.gameInstance.spawn('crate', 0, 0).tag('enemy');
        const touching = a.getTouching();
        expect(Array.isArray(touching)).toBe(true);
        expect(touching).toHaveLength(0); // no collider on `a`
    });

    it('excludes self and reports overlap once a collider is present', () => {
        const rt = loadGame({ bounds: bounds(-100, 100, 100, -100) });
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        const b = rt.wired.gameInstance.spawn('crate', 0, 0).tag('enemy');
        a.collider = { enabled: true, isTrigger: false, bounds: bounds(-10, 10, 10, -10) };
        b.collider = { enabled: true, isTrigger: false, bounds: bounds(-10, 10, 10, -10) };

        const touching = a.getTouching();
        expect(touching).not.toContain(a); // self excluded
        expect(touching.map((e) => e.id)).toContain(b.id);

        expect(a.getTouching('enemy').map((e) => e.id)).toEqual([b.id]);
        expect(a.getTouching('nonexistent')).toHaveLength(0);
    });
});

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { entityKey } from '../src/runtime/hosts.js';
import { Loop } from '../src/loop/loop.js';
import { LoadError } from '../src/errors.js';
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

    it('cascades to children: the whole subtree flips alive false', () => {
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

/** Destroys one entity, drains it, and mints the next into the slot it freed. */
function reused(): {
    rt: ReturnType<typeof loadGame>;
    stale: ReturnType<ReturnType<typeof loadGame>['wired']['gameInstance']['spawn']>;
    fresh: ReturnType<ReturnType<typeof loadGame>['wired']['gameInstance']['spawn']>;
} {
    const rt = loadGame();
    const stale = rt.wired.gameInstance.spawn('bullet', 10, 20);
    stale.destroy();
    rt.entityManager.drainDestroyed();
    const fresh = rt.wired.gameInstance.spawn('enemy', 100, 200);
    // The premise: the same slot, a newer generation.
    expect(rt.entities.indexOf(fresh.entityId)).toBe((stale.entityId as number) % 0x100_0000);
    return { rt, stale, fresh };
}

describe('a stale handle whose slot was reused', () => {
    it('writes nothing to the entity that now owns the slot', () => {
        const { rt, stale, fresh } = reused();
        rt.transforms.consumeDirty();
        stale.setPosition(5, 5).setRotation(90).setScale(3).moveBy(1, 1);
        stale.opacity = 0;
        stale.layer = 7;

        expect(fresh.position).toEqual({ x: 100, y: 200, z: 0 });
        expect(fresh.rotation).toBe(0);
        expect(fresh.scale).toBe(1);
        expect(fresh.opacity).toBe(1);
        expect(fresh.layer).toBe(0);
        // Nothing marked either: a dirty slot replicates the new entity's transform as if it moved.
        expect(rt.transforms.consumeDirty()).toEqual([]);
    });

    it('reads the identity transform rather than the new owner’s', () => {
        const { stale } = reused();
        expect(stale.position).toEqual({ x: 0, y: 0, z: 0 });
        expect(stale.scale).toBe(1);
    });

    it('tags nothing, so the new owner carries only its own tags', () => {
        const { rt, stale, fresh } = reused();
        stale.tag('ghost');
        stale.say('boo');
        expect(fresh.tags).toEqual([]);
        expect(fresh.hasTag('ghost')).toBe(false);
        expect(rt.wired.gameInstance.find({ tag: 'ghost' })).toHaveLength(0);
    });

    it('starts no tween and no timer, and resolves at once', async () => {
        const { rt, stale, fresh } = reused();
        await stale.glideTo(500, 500, 1);
        await stale.fadeOut(1);
        await stale.say('late', 1);
        await stale.think('later', 1);
        expect(rt.timers.pendingCount).toBe(0);
        // No host record resurrected for a dead entity: one would sit in the table for good.
        expect(rt.hosts.get(entityKey(stale.entityId as number))).toBeUndefined();

        const loop = new Loop(rt);
        for (let tick = 1; tick <= rt.simRate; tick++) loop.step(tick);
        expect(fresh.position).toEqual({ x: 100, y: 200, z: 0 });
        expect(fresh.opacity).toBe(1);
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

describe('attachTo', () => {
    it('refuses a parent already inside the child’s own subtree', () => {
        // Two lines from any script build a chain with no root, and everything that walks a parent
        // chain after it (the destroy cascade first) never terminates.
        const rt = loadGame();
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        const b = rt.wired.gameInstance.spawn('crate', 1, 0);
        a.attachTo(b);

        expect(() => b.attachTo(a)).toThrow(LoadError);
        expect(() => a.attachTo(a)).toThrow(LoadError);
        // Refused before anything moved: `b` is still the root it was.
        expect(b.parent).toBeNull();
        expect(b.children.map((c) => c.id)).toStrictEqual([a.id]);
    });

    it('leaves a legal deep chain alone, and reparenting sideways still works', () => {
        const rt = loadGame();
        const root = rt.wired.gameInstance.spawn('crate', 0, 0);
        const mid = rt.wired.gameInstance.spawn('crate', 1, 0).attachTo(root);
        const leaf = rt.wired.gameInstance.spawn('crate', 2, 0).attachTo(mid);
        expect(leaf.parent?.id).toBe(mid.id);

        leaf.attachTo(root);
        expect(leaf.parent?.id).toBe(root.id);
        expect(mid.children).toStrictEqual([]);
    });
});

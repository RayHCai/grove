// Marks record what a consumer has yet to drain, not simulation state, so no snapshot holds them.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { NO_ENTITY } from '../src/ids.js';

afterEach(() => clearRuntime());

describe('replication channels', () => {
    it('a spawn marks structural; a move marks the transform bitset on the store', () => {
        const rt = loadGame();
        rt.channels.clear();
        rt.transforms.consumeDirty();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        expect(rt.channels.structuralCount).toBeGreaterThanOrEqual(1);
        rt.channels.drainStructural();
        rt.transforms.consumeDirty(); // clear the spawn-time position mark

        e.setPosition(5, 5);
        // The transform channel is the store's own dirty set, not the channels object.
        expect(rt.transforms.isDirty(e.entityId)).toBe(true);
        expect(rt.channels.structuralCount).toBe(0);
    });

    it('the channels are not captured by snapshot — a restore leaves live marks alone', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        loop.step(1);
        const snap = loop.snapshot();

        rt.channels.clear();
        e.tag('moved');
        expect(rt.channels.structuralCount).toBe(1);

        loop.restore(snap);
        expect(rt.channels.structuralCount).toBe(1);
    });

    it('the channel store is not in the snapshot registry', () => {
        const rt = loadGame();
        const names = rt.registry.stores.map((s) => s.storeName);
        expect(names).not.toContain('channels');
    });
});

describe('detach marks the structural channel', () => {
    it('a detach journals reparent to NO_ENTITY, and attachTo marks only the new parent', () => {
        const rt = loadGame();
        const parent = rt.gameInstance!.spawn('parent', 0, 0);
        const child = rt.gameInstance!.spawn('child', 0, 0);
        rt.channels.drainStructural();

        child.attachTo(parent);
        // One op: the reparent already says where the child went, so the unlink stays silent.
        const attached = rt.channels.drainStructural();
        expect(attached).toStrictEqual([
            { kind: 'reparent', id: child.entityId, parent: parent.entityId },
        ]);

        child.detach();
        // The transform channel carries no hierarchy, so an unmarked detach never reaches clients.
        expect(rt.channels.drainStructural()).toStrictEqual([
            { kind: 'reparent', id: child.entityId, parent: NO_ENTITY },
        ]);
    });

    it('detaching an unparented entity marks nothing', () => {
        const rt = loadGame();
        const loose = rt.gameInstance!.spawn('loose', 0, 0);
        rt.channels.drainStructural();
        loose.detach();
        expect(rt.channels.structuralCount).toBe(0);
    });
});

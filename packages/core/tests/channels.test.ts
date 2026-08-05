// The three replication channels (DESIGN §5.1) are separate and are NOT snapshot state
// (§8.1): a restore leaves live marks untouched, since they record what a consumer has yet
// to drain, not simulation state.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';

afterEach(() => clearRuntime());

describe('replication channels (§5.1, §8.1)', () => {
    it('a spawn marks structural; a move marks the transform bitset on the store', () => {
        const rt = loadGame();
        rt.channels.clear();
        rt.transforms.consumeDirty();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        expect(rt.channels.structuralCount).toBeGreaterThanOrEqual(1); // spawn journalled
        rt.channels.drainStructural();
        rt.transforms.consumeDirty(); // clear the spawn-time position mark

        e.setPosition(5, 5);
        // The transform channel is the store's own dense bitset (§5.1), not the channels obj.
        expect(rt.transforms.isDirty(e.entityId)).toBe(true);
        expect(rt.channels.structuralCount).toBe(0); // move is not structural
    });

    it('the channels are not captured by snapshot — a restore leaves live marks alone', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        loop.step(1);
        const snap = loop.snapshot();

        rt.channels.clear();
        e.tag('moved'); // a structural mark after the snapshot
        expect(rt.channels.structuralCount).toBe(1);

        loop.restore(snap);
        // The mark survives the restore — it records what a consumer has yet to drain, not
        // simulation state (§8.1).
        expect(rt.channels.structuralCount).toBe(1);
    });

    it('the channel store is not in the snapshot registry', () => {
        const rt = loadGame();
        const names = rt.registry.stores.map(s => s.storeName);
        expect(names).not.toContain('channels');
    });
});

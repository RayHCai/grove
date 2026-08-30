// A rewind sweeps invocations newer than the target tick: a handler parked
// at an await from a timeline that did not happen is marked dead, releasing its
// concurrency lock so the same event can fire fresh after the rewind.

import { describe, it, expect, afterEach } from 'vitest';
import { Cooldown } from '../dist/testkit/fixtures.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { instanceOf } from './helpers.js';

afterEach(() => clearRuntime());

describe('parked-invocation sweep', () => {
    it('restore releases a concurrency lock held by an invocation newer than the snapshot', () => {
        const rt = loadGame();
        const loop = new Loop(rt);

        // The entity and its script exist BEFORE the snapshot, so the rewind keeps them;
        // only the parked INVOCATION (started after the snapshot) is swept.
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Cooldown as never);
        const inst = instanceOf<Cooldown>(rt, e, 'Cooldown');

        loop.step(5);
        const snap = loop.snapshot(); // tick 5, entity present, no invocation running

        // At tick 6, an ignore-mode handler parks at its await, holding the lock.
        loop.step(6);
        void e.send('attack');
        expect(inst.fires).toBe(1);
        void e.send('attack'); // dropped — lock held
        expect(inst.fires).toBe(1);

        // Rewind to tick 5: the parked invocation (started at tick 6) is swept, lock released.
        loop.restore(snap);
        expect(rt.tick).toBe(5);
        expect(e.alive).toBe(true); // the entity predates the snapshot, so it survives

        // The same handler can now fire fresh — the lock is gone.
        void e.send('attack');
        expect(inst.fires).toBe(2);
    });

    it('a synchronous handler is unaffected by the sweep', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        loop.step(3);
        const snap = loop.snapshot();
        loop.step(4);
        // no parked invocations exist; restore is a clean rewind
        loop.restore(snap);
        expect(rt.tick).toBe(3);
    });
});

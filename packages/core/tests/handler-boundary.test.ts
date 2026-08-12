// What the dispatcher owes a handler that misbehaves: an async throw counts toward the breaker,
// and a nested synchronous send gives the outer handler its invocation back.

import { describe, it, expect, afterEach } from 'vitest';
import { AsyncFaulty, Nester } from '../dist/testkit/fixtures.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { after } from '../src/runtime/time.js';
import { BREAKER_THRESHOLD } from '../src/config.js';

afterEach(() => clearRuntime());

describe('breaker', () => {
    it('counts an async throw, so a handler that always rejects is disabled', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(AsyncFaulty as never);

        for (let i = 0; i < BREAKER_THRESHOLD; i++) await e.send('boom');

        // Recording success when the call returned — at the first await — reset the count before
        // the rejection arrived, so it never passed 1 and the handler ran forever.
        expect(rt.log.records.some((r) => r.disabled)).toBe(true);

        const before = rt.log.records.length;
        await e.send('boom');
        expect(rt.log.records.length).toBe(before);
    });

    it('logs one record per distinct message and counts the repeats', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(AsyncFaulty as never);

        for (let i = 0; i < 5; i++) await e.send('boom');

        const thrown = rt.log.records.filter((r) => !r.disabled);
        expect(thrown).toHaveLength(1);
        expect(rt.dispatcher.throwCount('AsyncFaulty', 'boom', 'async handler always throws')).toBe(
            5,
        );
    });
});

describe('nested dispatch', () => {
    it('leaves the outer handler its own invocation, so a timer it starts is owned by its host', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(Nester as never);
        const inst = instanceOf<Nester>(rt, e, 'Nester');

        let fired = 0;
        inst.afterNestedSend = () => {
            after(1, () => {
                fired++;
            });
        };

        void e.send('outer');
        expect(inst.nestedRuns).toBe(1);
        expect(rt.timers.pendingCount).toBe(1);

        // Owned by this entity's host, so its teardown cancels it. Clearing the ambient invocation
        // after the nested send instead left the timer hostless and outliving its entity.
        e.destroy();
        for (let t = 1; t <= 70; t++) loop.step(t);
        expect(fired).toBe(0);
    });
});

function instanceOf<T>(
    rt: ReturnType<typeof loadGame>,
    e: { entityId: unknown },
    className: string,
): T {
    for (const si of rt.instances.forHost(`entity:${e.entityId as number}`)) {
        if (si.className === className) return si.instance as T;
    }
    throw new Error(`${className} not attached`);
}

// Containment beyond the dispatcher: the paths that run creator code without a dispatch — the
// movement pass, a timer callback, a tween's write and a countdown's completion — keep the tick
// alive and charge the throw to the script instance that owns the code.
//
// Each case drives a real `Loop.step`, because what these guards prevent is an exception unwinding
// through the pass into the frame source, and a direct call to the guarded function would not.

import { describe, it, expect, afterEach } from 'vitest';
import { Faulty, FaultyMovement, Nester } from '../dist/testkit/fixtures.js';
import { joinPlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';
import { Loop } from '../src/loop/loop.js';
import { after } from '../src/runtime/time.js';
import { tween } from '../src/runtime/motion.js';
import { Countdown } from '../src/runtime/wrappers.js';
import { BREAKER_THRESHOLD } from '../src/config.js';
import type { BreakerTrip } from '../src/errors.js';
import { entityKey } from '../src/runtime/hosts.js';

afterEach(() => clearRuntime());

/** A joined player with an avatar whose movement class throws in its one required stage. */
function faultyMover(rt: Runtime): Player {
    const player = joinPlayer(rt, 'p1', 'P');
    player.spawn();
    player.setMovement(FaultyMovement as never);
    return player;
}

/**
 * Runs `fn` inside a handler invocation, which is the only place a callback can be registered with
 * an owner — the ambient invocation is where the owning instance comes from.
 */
function inHandler(rt: Runtime, fn: () => void): { instance: object; id: number } {
    const e = rt.wired.gameInstance.spawn('crate', 0, 0);
    e.addScript(Nester as never);
    const si = rt.instances.forHost(entityKey(e.entityId as number))[0]!;
    (si.instance as { afterNestedSend: (() => void) | null }).afterNestedSend = fn;
    void e.send('outer');
    return si;
}

describe('the movement pass', () => {
    it('does not abort the tick when an override throws', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        faultyMover(rt);

        expect(() => loop.step(1)).not.toThrow();

        const record = rt.log.records.find((r) => r.event === '@movement');
        expect(record?.scriptClass).toBe('FaultyMovement');
        expect(record?.method).toBe('tick');
    });

    it('charges the trip to the movement instance and reports it to the host', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const player = faultyMover(rt);
        const owner = rt.instances.forInstance(player.movement!)!;

        const trips: BreakerTrip[] = [];
        rt.dispatcher.onTrip((trip) => trips.push(trip));

        for (let t = 1; t <= BREAKER_THRESHOLD; t++) loop.step(t);

        expect(trips).toHaveLength(1);
        expect(trips[0]).toMatchObject({
            scriptClass: 'FaultyMovement',
            instanceId: owner.id,
            method: 'tick',
            event: '@movement',
            hostId: entityKey(player.avatar.entityId as number),
        });

        // Disabled, not merely counted: the breaker gates the call, so the next tick logs nothing.
        const before = rt.log.records.length;
        loop.step(BREAKER_THRESHOLD + 1);
        expect(rt.log.records.length).toBe(before);
    });
});

describe('the timer heap', () => {
    it('does not abort the tick when a callback throws, and names the registering script', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const owner = inHandler(rt, () => {
            after(1 / rt.simRate, () => {
                throw new Error('timer always throws');
            });
        });

        expect(() => loop.step(1)).not.toThrow();

        const record = rt.log.records.find((r) => r.event === '@timer');
        expect(record?.scriptClass).toBe('Nester');
        // Keyed on the timer, not on the method that registered it: that method already returned,
        // so disabling it would leave the callback firing.
        expect(record?.method).toMatch(/^timer:\d+$/);
        expect(rt.instances.forInstance(owner.instance)?.id).toBe(owner.id);
    });
});

describe('the tween engine', () => {
    it('does not abort the tick when the target it writes throws', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        inHandler(rt, () => {
            const target = {};
            Object.defineProperty(target, 'value', {
                get: () => 0,
                set: () => {
                    throw new Error('setter always throws');
                },
            });
            void tween(target, { value: 1 }, 1 / rt.simRate);
        });

        expect(() => loop.step(1)).not.toThrow();
        expect(rt.log.records.find((r) => r.event === '@tween')?.scriptClass).toBe('Nester');
    });
});

describe('a countdown', () => {
    it('does not abort the tick when its completion throws', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        inHandler(rt, () => {
            new Countdown(1 / rt.simRate, () => {
                throw new Error('countdown always throws');
            }).start();
        });

        expect(() => loop.step(1)).not.toThrow();

        const record = rt.log.records.find((r) => r.event === '@countdown');
        expect(record?.scriptClass).toBe('Nester');
        expect(record?.method).toMatch(/^countdown:\d+$/);
    });
});

describe('the dispatcher boundary', () => {
    it('contains a throw from READING the handler, not only from calling it', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Faulty as never);
        const si = rt.instances.forHost(entityKey(e.entityId as number))[0]!;
        // A handler declared as an accessor makes the property read itself creator code; the lookup
        // used to sit above the try, so this threw straight out of the dispatch.
        Object.defineProperty(si.instance, 'boom', {
            configurable: true,
            get(): never {
                throw new Error('accessor handler always throws');
            },
        });

        expect(() => void e.send('boom')).not.toThrow();
        expect(rt.log.records.at(-1)?.scriptClass).toBe('Faulty');
    });

    it('contains a throw from the host trip listener, so a reporting bug cannot end a tick', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        faultyMover(rt);
        rt.dispatcher.onTrip(() => {
            throw new Error('host listener always throws');
        });

        for (let t = 1; t <= BREAKER_THRESHOLD; t++) {
            expect(() => loop.step(t)).not.toThrow();
        }
        expect(rt.log.records.some((r) => r.method === 'onBreakerTrip')).toBe(true);
    });
});

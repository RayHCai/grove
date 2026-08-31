// The one tween engine under every timed motion verb: last-one-wins, cancellation, easing and
// ownership. Each is defined once here so `glideTo`, `fadeTo`, `growTo` and `tween(this, …)` cannot
// disagree about any of them.
//
// The engine is deliberately NOT a snapshot store, which is asserted below rather than described:
// a rewind restores transforms and leaves an in-flight tween running, so a client that rewinds mid
// glide keeps gliding rather than snapping.

import { describe, it, expect, afterEach } from 'vitest';
import { TweenEngine } from '../src/loop/tweens.js';
import type { TweenTarget } from '../src/loop/tweens.js';
import { NO_SCOPE } from '../src/dispatch/scope-tree.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { tween } from '../src/runtime/motion.js';
import { entityKey } from '../src/runtime/hosts.js';

afterEach(() => clearRuntime());

const SCOPE = 1;

function engine(): TweenEngine {
    const e = new TweenEngine();
    e.setSimRate(60);
    return e;
}

/** A target that records every write, so the interpolation itself is inspectable. */
function target(key = 'probe', start = 0): TweenTarget & { value: number; writes: number[] } {
    const state = {
        key,
        value: start,
        writes: [] as number[],
        get(): number {
            return state.value;
        },
        set(_prop: string, value: number): void {
            state.value = value;
            state.writes.push(value);
        },
    };
    return state;
}

describe('interpolation', () => {
    it('walks from the value it started at to the target and stops there', () => {
        const e = engine();
        const t = target('a', 10);
        void e.start(t, 'value', 20, 4 / 60, SCOPE);

        e.advance();
        e.advance();
        expect(t.value).toBe(15); // halfway at the halfway tick
        e.advance();
        e.advance();
        expect(t.value).toBe(20);

        e.advance();
        expect(t.writes).toHaveLength(4); // finished and left, so no fifth write
    });

    it('reads `from` at the start rather than at each tick', () => {
        // Otherwise a second writer to the same property would drag the tween's origin with it and
        // the curve would restart from wherever the last frame landed.
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 10, 2 / 60, SCOPE);
        t.value = 1000;
        e.advance();
        expect(t.value).toBe(5);
    });

    it('rounds a sub-tick duration up to one tick rather than dividing by zero', () => {
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 1, 0, SCOPE);
        e.advance();
        expect(t.value).toBe(1);
    });

    it('applies the easing curve it was given', () => {
        const e = engine();
        const linear = target('linear', 0);
        const eased = target('eased', 0);
        void e.start(linear, 'value', 1, 4 / 60, SCOPE, 'linear');
        void e.start(eased, 'value', 1, 4 / 60, SCOPE, 'easeIn');

        e.advance();
        expect(linear.value).toBe(0.25);
        expect(eased.value).toBe(0.25 ** 3);

        e.advance();
        e.advance();
        e.advance();
        // Both land exactly on the target: an easing curve that missed 1 at t=1 would leave every
        // timed verb in the engine a hair short of where the creator asked for.
        expect(linear.value).toBe(1);
        expect(eased.value).toBe(1);
    });

    it('defaults to linear', () => {
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 4, 4 / 60, SCOPE);
        e.advance();
        expect(t.value).toBe(1);
    });
});

describe('awaiting', () => {
    it('resolves when the tween reaches its target', async () => {
        const e = engine();
        const t = target('a', 0);
        let done = false;
        const parked = e.start(t, 'value', 1, 2 / 60, SCOPE).then(() => {
            done = true;
        });

        e.advance();
        await Promise.resolve();
        expect(done).toBe(false);

        e.advance();
        await parked;
        expect(done).toBe(true);
    });

    it('resolves a cancelled tween too, so an await never hangs', async () => {
        const e = engine();
        const t = target('a', 0);
        const parked = e.start(t, 'value', 1, 10 / 60, SCOPE);
        e.advance();
        e.cancelScope(SCOPE);
        // The creator wrote `await glideTo(...)`; a cancel that left the promise pending would park
        // that handler for the session and hold its concurrency lock with it.
        await expect(parked).resolves.toBeUndefined();
    });
});

describe('last one wins', () => {
    it('a second tween on the same (target, prop) cancels the first', () => {
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 100, 10 / 60, SCOPE);
        e.advance();
        const afterFirst = t.value;

        void e.start(t, 'value', 0, 10 / 60, SCOPE);
        e.advance();
        // Walking back toward 0 from where the first one stopped, not onward toward 100.
        expect(t.value).toBeLessThan(afterFirst);
    });

    it('leaves the property where the cancelled tween stopped, not at its target', () => {
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 100, 10 / 60, SCOPE);
        e.advance();
        const stopped = t.value;
        e.cancelScope(SCOPE);
        e.advance();
        expect(t.value).toBe(stopped);
    });

    it('keeps two properties on one target independent', () => {
        const e = engine();
        const t = target('a', 0);
        const writes: Array<[string, number]> = [];
        const twoProp: TweenTarget = {
            key: 'two',
            get: () => 0,
            set: (prop, value) => writes.push([prop, value]),
        };
        void t;
        void e.start(twoProp, 'x', 10, 2 / 60, SCOPE);
        void e.start(twoProp, 'y', 20, 2 / 60, SCOPE);
        e.advance();
        expect(writes).toStrictEqual([
            ['x', 5],
            ['y', 10],
        ]);
    });

    it('keeps one property on two targets independent', () => {
        const e = engine();
        const a = target('a', 0);
        const b = target('b', 0);
        void e.start(a, 'value', 10, 2 / 60, SCOPE);
        void e.start(b, 'value', 20, 2 / 60, SCOPE);
        e.advance();
        expect([a.value, b.value]).toStrictEqual([5, 10]);
    });
});

describe('cancellation', () => {
    it('cancelScope takes one host’s tweens and leaves another’s', () => {
        const e = engine();
        const mine = target('mine', 0);
        const theirs = target('theirs', 0);
        void e.start(mine, 'value', 10, 10 / 60, 1);
        void e.start(theirs, 'value', 10, 10 / 60, 2);

        e.cancelScope(1);
        e.advance();
        expect(mine.value).toBe(0);
        expect(theirs.value).toBeGreaterThan(0);
    });

    it('cancelScope(NO_SCOPE) takes nothing', () => {
        const e = engine();
        const t = target('a', 0);
        void e.start(t, 'value', 10, 2 / 60, NO_SCOPE);
        e.cancelScope(NO_SCOPE);
        e.advance();
        expect(t.value).toBe(5);
    });

    it('a destroyed entity cancels the tweens it owned', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.hosts.ensure(entityKey(e.entityId as number));

        void e.glideTo(100, 0, 1);
        loop.step(1);
        expect(e.position.x).toBeGreaterThan(0);

        e.destroy();
        loop.step(2);
        const stopped = rt.transforms.posX(e.entityId);
        loop.step(3);
        expect(rt.transforms.posX(e.entityId)).toBe(stopped);
    });
});

describe('advance order', () => {
    it('is ascending id, because determinism needs one', () => {
        const e = engine();
        const order: string[] = [];
        const named = (name: string): TweenTarget => ({
            key: name,
            get: () => 0,
            set: () => order.push(name),
        });
        void e.start(named('first'), 'value', 1, 2 / 60, SCOPE);
        void e.start(named('second'), 'value', 1, 2 / 60, SCOPE);
        void e.start(named('third'), 'value', 1, 2 / 60, SCOPE);

        e.advance();
        expect(order).toStrictEqual(['first', 'second', 'third']);
    });

    it('survives a tween started from inside another tween’s write', () => {
        // A Set or Map visits what an iteration adds; the advance walks a snapshot of the keys, so
        // a tween minted mid-pass waits for the next tick rather than being advanced on its first.
        const e = engine();
        const late = target('late', 0);
        let started = false;
        const early: TweenTarget = {
            key: 'early',
            get: () => 0,
            set: () => {
                if (started) return;
                started = true;
                void e.start(late, 'value', 10, 2 / 60, SCOPE);
            },
        };
        void e.start(early, 'value', 1, 2 / 60, SCOPE);

        expect(() => e.advance()).not.toThrow();
        expect(late.writes).toHaveLength(0);
        e.advance();
        expect(late.writes).toHaveLength(1);
    });
});

describe('duration validation', () => {
    it('refuses a non-finite duration rather than holding its slot forever', () => {
        // Every interpolated value would be NaN and `t >= 1` never true, so the tween would keep
        // its (target, prop) slot for the session and every later tween on it would be cancelled
        // at birth.
        const e = engine();
        const t = target('a', 0);
        expect(() => e.start(t, 'value', 1, Infinity, SCOPE)).toThrow(RangeError);
        expect(() => e.start(t, 'value', 1, NaN, SCOPE)).toThrow(/finite/);

        // And the slot is still free afterwards.
        void e.start(t, 'value', 4, 4 / 60, SCOPE);
        e.advance();
        expect(t.value).toBe(1);
    });
});

describe('the engine is not snapshot state', () => {
    it('a rewind restores the transform but leaves the tween running', () => {
        // Deliberate: a parked tween is a heap closure no buffer holds, and the transform store is
        // what actually replicates. Pinned so a future "snapshot everything" cannot land silently.
        const rt = loadGame();
        const loop = new Loop(rt);
        const t = { value: 0 };

        loop.step(1);
        const snap = loop.snapshot();
        void tween(t, { value: 100 }, 10 / rt.simRate);

        loop.step(2);
        const midway = t.value;
        expect(midway).toBeGreaterThan(0);

        loop.restore(snap);
        loop.step(2);
        expect(t.value).toBeGreaterThan(midway);
    });

    it('the registry holds no tween store', () => {
        const rt = loadGame();
        expect(rt.registry.stores.map((s) => s.storeName)).not.toContain('tweens');
    });
});

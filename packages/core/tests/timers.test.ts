// The timer heap: ownership, cancellation, the tick↔seconds conversion, and the ordering rule.
//
// Time is counted in ticks internally and in seconds at the API, so every assertion below drives
// `advance()` a tick at a time rather than trusting a duration. Firing order is asserted explicitly
// because it is a determinism requirement, not a convenience: two peers replaying one tick must run
// the same callbacks in the same sequence or their worlds diverge from that tick on.

import { describe, it, expect, afterEach } from 'vitest';
import { TimerHeap } from '../src/loop/timers.js';
import { NO_SCOPE } from '../src/dispatch/scope-tree.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { after, every, sleep } from '../src/runtime/time.js';
import { entityKey } from '../src/runtime/hosts.js';

afterEach(() => clearRuntime());

/** A heap at 60 Hz with no runtime behind it — the store on its own. */
function heap(): TimerHeap {
    const h = new TimerHeap();
    h.setSimRate(60);
    return h;
}

const SCOPE = 1;

describe('after', () => {
    it('fires once at its due tick and leaves the heap', () => {
        const h = heap();
        let fired = 0;
        h.after(3 / 60, SCOPE, () => {
            fired += 1;
        });

        h.advance();
        h.advance();
        expect(fired).toBe(0);
        h.advance();
        expect(fired).toBe(1);
        expect(h.pendingCount).toBe(0);

        h.advance();
        expect(fired).toBe(1); // gone, so a later tick cannot spend it twice
    });

    it('rounds to at least one tick, so a sub-tick duration still fires', () => {
        const h = heap();
        let fired = 0;
        h.after(0, SCOPE, () => {
            fired += 1;
        });
        // Zero seconds is the next tick, never this one: firing inline would run creator code
        // outside the pass that owns the moment.
        expect(fired).toBe(0);
        h.advance();
        expect(fired).toBe(1);
    });
});

describe('every', () => {
    it('reloads its interval rather than drifting', () => {
        const h = heap();
        const at: number[] = [];
        let tick = 0;
        h.every(2 / 60, SCOPE, () => at.push(tick));

        for (tick = 1; tick <= 10; tick++) h.advance();
        expect(at).toStrictEqual([2, 4, 6, 8, 10]);
    });

    it('stays in the heap between firings', () => {
        const h = heap();
        h.every(2 / 60, SCOPE, () => {});
        h.advance();
        h.advance();
        expect(h.pendingCount).toBe(1);
    });
});

describe('sleep', () => {
    it('resolves at its due tick and not before', async () => {
        const h = heap();
        let woke = false;
        const parked = h.sleep(2 / 60, SCOPE).then(() => {
            woke = true;
        });

        h.advance();
        await Promise.resolve();
        expect(woke).toBe(false);

        h.advance();
        await parked;
        expect(woke).toBe(true);
    });

    it('a cancelled sleep never resolves, because its continuation is meant to be unreachable', async () => {
        const h = heap();
        let woke = false;
        void h.sleep(1 / 60, SCOPE).then(() => {
            woke = true;
        });
        h.cancelScope(SCOPE);

        h.advance();
        h.advance();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(woke).toBe(false);
        expect(h.pendingCount).toBe(0);
    });

    it('is awaitable from inside a handler and resumes it', async () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        let resumed = false;

        void (async () => {
            await sleep(2 / rt.simRate);
            resumed = true;
        })();
        void e;

        loop.step(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resumed).toBe(false);
        loop.step(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resumed).toBe(true);
    });
});

describe('cancellation', () => {
    it('the handle `after` returns cancels it', () => {
        const h = heap();
        let fired = 0;
        const cancel = h.after(2 / 60, SCOPE, () => {
            fired += 1;
        });
        cancel();
        expect(h.pendingCount).toBe(0);
        h.advance();
        h.advance();
        expect(fired).toBe(0);
    });

    it('the handle `every` returns stops the repeat mid-flight', () => {
        const h = heap();
        let fired = 0;
        const cancel = h.every(1 / 60, SCOPE, () => {
            fired += 1;
        });
        h.advance();
        h.advance();
        cancel();
        h.advance();
        expect(fired).toBe(2);
    });

    it('cancelling twice is not an error', () => {
        const h = heap();
        const cancel = h.after(1 / 60, SCOPE, () => {});
        cancel();
        expect(() => cancel()).not.toThrow();
    });

    it('cancelScope takes one host’s timers and leaves every other host’s', () => {
        const h = heap();
        const fired: string[] = [];
        h.after(1 / 60, 1, () => fired.push('one'));
        h.after(1 / 60, 2, () => fired.push('two'));

        h.cancelScope(1);
        h.advance();
        expect(fired).toStrictEqual(['two']);
    });

    it('cancelScope(NO_SCOPE) takes nothing, because no host owns the hostless', () => {
        // A teardown passing its own scope through would otherwise cancel every timer registered
        // outside a handler in the whole world.
        const h = heap();
        let fired = 0;
        h.after(1 / 60, NO_SCOPE, () => {
            fired += 1;
        });
        h.cancelScope(NO_SCOPE);
        h.advance();
        expect(fired).toBe(1);
    });

    it('a destroyed host takes its timers with it', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        // `ensure`, not `scopeForEntity`: an entity carrying no scripts has no host record yet, so
        // the lookup would answer NO_SCOPE and the timer below would be registered hostless.
        const scope = rt.hosts.ensure(entityKey(e.entityId as number)).scopeId;
        let fired = 0;
        rt.timers.every(1 / rt.simRate, scope, () => {
            fired += 1;
        });

        loop.step(1);
        expect(fired).toBe(1);

        e.destroy();
        loop.step(2);
        // Two, not one: `destroy` is logical-now but the teardown that cancels is the drain at the
        // end of the tick, and timers advance five passes before it. The last firing is on the tick
        // the entity dies, which is the same tick its `@onEnd` runs.
        expect(fired).toBe(2);

        loop.step(3);
        expect(fired).toBe(2);
        expect(rt.timers.pendingCount).toBe(0);
    });

    it('a timer against an entity with no host record is hostless, and outlives it', () => {
        // The asymmetry worth pinning: `scopeForEntity` answers NO_SCOPE for an entity nothing is
        // attached to, and NO_SCOPE is nobody's to cancel — so this timer survives the destroy.
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        expect(rt.hosts.scopeForEntity(e.entityId as unknown as number)).toBe(NO_SCOPE);

        let fired = 0;
        rt.timers.every(
            1 / rt.simRate,
            rt.hosts.scopeForEntity(e.entityId as unknown as number),
            () => {
                fired += 1;
            },
        );

        e.destroy();
        loop.step(1);
        loop.step(2);
        expect(fired).toBe(2);
    });
});

describe('firing order', () => {
    it('is ascending id, not insertion into the map or duration', () => {
        // Determinism needs one order and this is it: the ids are minted in registration order, so
        // two peers that registered the same timers register them the same way.
        const h = heap();
        const order: number[] = [];
        const first = h.after(3 / 60, SCOPE, () => order.push(1));
        void first;
        h.after(3 / 60, SCOPE, () => order.push(2));
        h.after(3 / 60, SCOPE, () => order.push(3));

        h.advance();
        h.advance();
        h.advance();
        expect(order).toStrictEqual([1, 2, 3]);
    });

    it('runs an overdue timer alongside a just-due one, still in id order', () => {
        const h = heap();
        const order: string[] = [];
        h.after(1 / 60, SCOPE, () => order.push('short'));
        h.after(1 / 60, SCOPE, () => order.push('also-short'));
        h.advance();
        expect(order).toStrictEqual(['short', 'also-short']);
    });
});

describe('duration validation', () => {
    it('refuses a non-finite duration rather than parking forever', () => {
        // `remaining` would be NaN, and NaN <= 0 is false for good — so the timer would neither
        // fire nor ever leave the heap, which is a leak that looks like a hung callback.
        const h = heap();
        expect(() => h.after(Infinity, SCOPE, () => {})).toThrow(RangeError);
        expect(() => h.every(NaN, SCOPE, () => {})).toThrow(/finite/);
        expect(() => h.sleep(-Infinity, SCOPE)).toThrow(RangeError);
        expect(h.pendingCount).toBe(0);
    });
});

describe('sim rate', () => {
    it('converts seconds at the rate in force when the timer was made', () => {
        const h = new TimerHeap();
        h.setSimRate(30);
        let fired = 0;
        h.after(1, SCOPE, () => {
            fired += 1;
        });
        for (let i = 0; i < 29; i++) h.advance();
        expect(fired).toBe(0);
        h.advance();
        expect(fired).toBe(1);
    });

    it('follows the runtime’s rate rather than a default of its own', () => {
        const rt = loadGame({ simRate: 20 });
        const loop = new Loop(rt);
        let fired = 0;
        rt.timers.after(1, NO_SCOPE, () => {
            fired += 1;
        });
        for (let t = 1; t <= 19; t++) loop.step(t);
        expect(fired).toBe(0);
        loop.step(20);
        expect(fired).toBe(1);
    });
});

describe('snapshot and restore', () => {
    it('a whole capture rewinds the id counter, so a replay mints the same ids', () => {
        // A re-run tick has to produce the same timer ids as the original, or the breaker keys and
        // the scoped-capture bookkeeping name different timers on the two runs.
        const h = heap();
        h.after(5 / 60, SCOPE, () => {});
        const buffer = h.createBuffer();
        h.capture(buffer, null);

        h.after(5 / 60, SCOPE, () => {});
        h.apply(buffer);

        expect(h.pendingCount).toBe(1);
        expect(buffer.nextId).toBe(2);
    });

    it('restores remaining time, so a rewound timer fires at its original tick', () => {
        const h = heap();
        let fired = 0;
        h.after(5 / 60, SCOPE, () => {
            fired += 1;
        });
        const buffer = h.createBuffer();
        h.capture(buffer, null);

        h.advance();
        h.advance();
        h.apply(buffer);

        for (let i = 0; i < 4; i++) h.advance();
        expect(fired).toBe(0);
        h.advance();
        expect(fired).toBe(1);
    });

    it('keeps the live callback, which no buffer can hold', () => {
        const h = heap();
        let fired = 0;
        h.after(2 / 60, SCOPE, () => {
            fired += 1;
        });
        const buffer = h.createBuffer();
        h.capture(buffer, null);
        h.apply(buffer);

        h.advance();
        h.advance();
        // Borrowed from the live timer of the same id: a restore that dropped `fn` would leave a
        // timer that counts down and then does nothing.
        expect(fired).toBe(1);
    });

    it('a scoped apply never rewinds the counter, because the skipped ids are already spent', () => {
        const h = heap();
        h.setScopeOwnerLookup(() => -1);
        h.after(5 / 60, SCOPE, () => {});
        const buffer = h.createBuffer();
        h.capture(buffer, new Set());

        h.after(5 / 60, SCOPE, () => {});
        h.apply(buffer);
        // Both survive: the capture covered no scope, so the apply replaced nothing.
        expect(h.pendingCount).toBe(2);
    });
});

describe('the runtime facade', () => {
    it('charges a timer to the host of the handler that registered it', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const scope = rt.hosts.ensure(entityKey(e.entityId as number)).scopeId;
        void scope;

        // Registered outside any handler, so it belongs to no host and survives every teardown.
        after(1, () => {});
        every(1, () => {});
        expect(rt.timers.pendingCount).toBe(2);

        e.destroy();
        rt.entityManager.drainDestroyed();
        expect(rt.timers.pendingCount).toBe(2);
    });
});

// The driver: the accumulator, the spiral guard, the shed's two halves, the send cadence, and the
// deliver→step order.
//
// It runs against a STUB step, so the clock is exercised without a world behind it. `apps/grove/host`
// owns this same policy in Rust, and these are the cases its own suite has to answer too.

import { describe, expect, it } from 'vitest';
import { defined } from '@platform/math';
import { Driver, maxStepsPerWake, ticksPerSend } from '../src/server/driver.js';

interface Spy {
    driver: Driver;
    steps: number[];
    sends: number[];
}

function spyDriver(simRate = 60, sendRate = 20, deliver?: () => void): Spy {
    const spy: Spy = { steps: [], sends: [], driver: null as unknown as Driver };
    let tick = 0;
    spy.driver = new Driver(
        {
            stepOnce: (drain) => {
                tick += 1;
                spy.steps.push(tick);
                if (drain) spy.sends.push(tick);
            },
        },
        { simRate, sendRate, ...defined({ deliver }) },
    );
    return spy;
}

describe('real time becomes ticks', () => {
    it('runs exactly k steps for k / simRate seconds and carries the remainder', () => {
        const spy = spyDriver();
        const dt = 1 / 60;
        spy.driver.pump(0);
        spy.driver.pump(5 * dt);
        expect(spy.steps).toHaveLength(5);

        // A fractional remainder stays in the accumulator rather than being rounded away.
        spy.driver.pump(5 * dt + dt / 2);
        expect(spy.steps).toHaveLength(5);
        expect(spy.driver.accumulator).toBeCloseTo(dt / 2, 10);
        spy.driver.pump(6 * dt + dt / 2);
        expect(spy.steps).toHaveLength(6);
    });

    it('a backwards clock is inert', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        spy.driver.pump(1);
        const ran = spy.steps.length;

        // Clamped to zero rather than subtracted: an NTP correction or a restored VM snapshot is a
        // reading behind the last one, and a negative delta would rewind the accumulator.
        expect(spy.driver.pump(0.5).steps).toBe(0);
        expect(spy.steps).toHaveLength(ran);
    });

    it('discards a non-finite reading rather than storing it', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        spy.driver.pump(Number.NaN);
        // Stored, every later `now - lastNow` is NaN and the counter is frozen for the session
        // rather than for one wake.
        spy.driver.pump(3 / 60);
        expect(spy.steps).toHaveLength(3);
    });

    it('reports the reading it was last given, however that reading moved', () => {
        const spy = spyDriver();
        spy.driver.pump(100);
        spy.driver.pump(101);
        spy.driver.pump(50);
        // The raw reading the batch stamps its clock from. The accumulator is what refuses to go
        // backwards, not this.
        expect(spy.driver.nowSeconds).toBe(50);
    });
});

describe('the step cap sheds wall-clock, never ticks', () => {
    it('caps one wake and sheds the backlog it could not reach', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        const result = spy.driver.pump(5);

        expect(result.steps).toBe(maxStepsPerWake(60));
        expect(result.shed).toBe(true);
        expect(spy.driver.shedCount).toBe(1);
        // Zeroed, so the next wake starts level rather than owing five seconds forever — a bounded
        // visible slowdown instead of the spiral of death.
        expect(spy.driver.accumulator).toBe(0);
    });

    it('keeps a legitimate remainder when the cap was hit but the backlog drained', () => {
        const spy = spyDriver();
        const cap = maxStepsPerWake(60);
        spy.driver.pump(0);
        const result = spy.driver.pump(cap / 60);

        expect(result.steps).toBe(cap);
        // Conditioned on LEFTOVER backlog: a wake that needed exactly the cap and drained cleanly
        // has nothing to shed.
        expect(result.shed).toBe(false);
        expect(spy.driver.shedCount).toBe(0);
    });

    it('steps a contiguous tick counter, so a shed costs latency rather than existence', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        spy.driver.pump(5);

        // Core's timers and tweens advance one unit per step() whatever index it is handed, so a
        // driver that skipped indices would compress every `after`, `every`, `sleep` and tween.
        expect(spy.steps).toStrictEqual(spy.steps.map((_, i) => i + 1));
    });
});

describe('send-tick accounting lives on the driver', () => {
    it('fires exactly one broadcast per simRate / sendRate steps', () => {
        const spy = spyDriver(60, 20);
        const perSend = ticksPerSend(60, 20);
        expect(perSend).toBe(3);

        spy.driver.pump(0);
        spy.driver.pump(perSend / 60);
        expect(spy.sends).toHaveLength(1);
        spy.driver.pump((2 * perSend) / 60);
        expect(spy.sends).toHaveLength(2);
    });

    it('keeps the cadence across a mid-session rate change', () => {
        const spy = spyDriver(60, 20);
        spy.driver.pump(0);
        spy.driver.pump(3 / 60);
        expect(spy.sends).toHaveLength(1);

        // Held on the driver rather than derived from `rt.tick % N`, so a setSimRate cannot desync it.
        spy.driver.setRates(30, 10);
        spy.driver.pump(3 / 60 + 3 / 30);
        expect(spy.sends).toHaveLength(2);
    });
});

describe('the driver owns the deliver→step sequence', () => {
    it('delivers before it steps, every wake', () => {
        const order: string[] = [];
        const driver = new Driver(
            { stepOnce: (drain) => order.push(drain ? 'step+send' : 'step') },
            { simRate: 60, sendRate: 20, deliver: () => order.push('deliver') },
        );
        driver.pump(0);
        driver.pump(3 / 60);

        // deliver, then this wake's steps — never the reverse, which still runs and reports nothing
        // while costing every input a tick of latency.
        expect(order).toStrictEqual(['deliver', 'deliver', 'step', 'step', 'step+send']);
    });
});

describe('a misconfigured clock says so instead of going quiet', () => {
    it('refuses a rate the accumulator could never reach', () => {
        expect(() => spyDriver(0)).toThrow(/simRate/);
        expect(() => spyDriver(60, Number.NaN)).toThrow(/sendRate/);
    });
});

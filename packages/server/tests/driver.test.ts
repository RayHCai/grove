// The driver: the accumulator, the spiral guard, the shed's two halves, the send cadence, and the
// deliver→step order.
//
// The accumulator half runs against a STUB step, so it is exercised without reading a channel. No
// test calls `pair.deliver()` itself — the driver is handed it, and a test that had to order the
// two would be reproducing the bug that owning the sequence removes.

import { afterEach, describe, expect, it } from 'vitest';
import { after, clearRuntime, entityKey } from '@platform/core';
import { defined } from '@platform/math';
import { Recorder, Rules } from '../dist/testkit/fixtures.js';
import { Driver } from '../src/driver.js';
import { maxStepsPerWake, ticksPerSend } from '../src/constants.js';
import { harness } from './harness.js';

afterEach(() => {
    clearRuntime();
});

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
            stepOnce: () => {
                tick += 1;
                spy.steps.push(tick);
            },
            send: () => spy.sends.push(tick),
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
        const result = spy.driver.pump(0.5);
        expect(result.steps).toBe(0);
        expect(spy.steps).toHaveLength(ran);
    });

    it('a non-finite clock reading is discarded, not stored', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        spy.driver.pump(Number.NaN);
        // Stored, every later `now - lastNow` would be NaN — freezing the counter for the session
        // rather than for a wake.
        const result = spy.driver.pump(10 / 60);
        expect(result.steps).toBe(10);
    });
});

describe('the step cap is a spiral guard', () => {
    it('caps the wake, sheds the backlog, and does not jump the tick counter', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        const result = spy.driver.pump(5); // five seconds of backlog at 60 Hz

        const cap = maxStepsPerWake(60);
        expect(result.steps).toBe(cap);
        expect(result.shed).toBe(true);
        expect(spy.driver.accumulator).toBe(0);
        expect(spy.driver.shedCount).toBe(1);
        // Contiguous: the tick advanced by exactly the cap, not by the whole gap.
        expect(spy.steps.at(-1)).toBe(cap);
    });

    it('a wake that needs exactly the cap and drains cleanly does not shed', () => {
        const spy = spyDriver();
        spy.driver.pump(0);
        const result = spy.driver.pump(maxStepsPerWake(60) / 60);
        expect(result.steps).toBe(maxStepsPerWake(60));
        // An unconditional `if (steps === cap) accumulator = 0` would have discarded a legitimate
        // remainder here; the shed is conditioned on leftover backlog instead.
        expect(result.shed).toBe(false);
        expect(spy.driver.shedCount).toBe(0);
    });

    it('a shed does not compress simulated time', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.joined('a');
        let fired = -1;
        const scheduledAt = h.tick;
        // Seconds, not ticks: 0.5 s is 30 ticks at 60 Hz.
        after(0.5, () => {
            fired = h.server.runtime.tick;
        });

        h.pump(5); // a multi-second gap: the cap sheds the rest
        expect(fired).toBe(-1);
        h.pumpTicks(40);

        // Core's timers advance ONE unit per step() call, ignoring the index — so the timer fires 30
        // STEPPED ticks later, not 30 ticks of wall-clock later.
        expect(fired).toBe(scheduledAt + 30);
    });

    it('shed input merges forward, and the ack reports it late', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = onRecorder(h);

        // Buffered for a tick the shed will step past.
        peer.input(h.tick + 3, [{ action: 'jump', on: 'press' }]);
        peer.clear();
        h.pump(5);
        h.pumpTicks(6);

        expect(rec.presses).toBe(1);
        // Applied late rather than never, and the ack names it — a real signal, not a permanent gap.
        expect(peer.lastState?.ackSeq).toBe(0);
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
            { stepOnce: () => order.push('step'), send: () => order.push('send') },
            { simRate: 60, sendRate: 20, deliver: () => order.push('deliver') },
        );
        driver.pump(0);
        driver.pump(3 / 60);

        // deliver, then this wake's steps — never the reverse, which still runs and reports nothing
        // while costing every input a tick of latency.
        expect(order).toStrictEqual(['deliver', 'deliver', 'step', 'step', 'step', 'send']);
    });

    it('an input sent before the wake applies on THAT wake, not the next', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rec = onRecorder(h);

        // Names the tick this wake will step. Reversed — step then deliver — this frame would land
        // after the step and apply one tick late, with no error and nothing to report it.
        peer.input(h.tick + 1, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(1);
        expect(rec.presses).toBe(1);
    });
});

/** The recorder on the first player's avatar. */
function onRecorder(h: ReturnType<typeof harness>): Recorder {
    const avatar = h.server.runtime.playerManager?.players[0]?.avatar;
    avatar?.addScript(Recorder as never);
    const host = entityKey(avatar?.entityId as unknown as number);
    return [...h.server.runtime.instances.forHost(host)].find((i) => i.className === 'Recorder')
        ?.instance as Recorder;
}

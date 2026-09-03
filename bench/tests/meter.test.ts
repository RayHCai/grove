// The meter's own contract. Every number this package emits is worthless if these do not hold, and
// the first one is a regression test for the failure that produced a whole run of clean zeroes.

import { describe, expect, it } from 'vitest';
import { Meter, asyncDriverOf, driverOf, ticksForBudget } from '../dist/meter.js';

/** A preallocated cell, so the quiet driver below can do work without reaching the heap. */
const scratch = new Float64Array(1);

/** Roughly `count * 112` bytes of short-lived garbage, which is what these windows are sized by. */
function churn(count: number): () => void {
    return () => {
        let sink: unknown = null;
        for (let i = 0; i < count; i++) sink = { a: i, b: [i, i + 1], c: `key-${i}` };
        if (sink === null) throw new Error('unreachable');
    };
}

/** About 2 MB a tick: several of these fill the default young generation, one does not. */
const LIGHT = churn(20_000);
/** About 11 MB a tick, so even a window at the floor cannot complete without collecting. */
const HEAVY = churn(100_000);

describe('gc accounting', () => {
    it('sees collections that a blocking window would have hidden', async () => {
        const meter = new Meter();
        try {
            const sample = await meter.gcProfile(driverOf(LIGHT), 3, 20);
            // The whole point: entries reach an observer on a task, so a profile that never turned
            // the loop would report zero here no matter how much it allocated.
            expect(sample.gc.scavenge + sample.gc.markSweep).toBeGreaterThan(0);
            expect(sample.gc.totalMs).toBeGreaterThan(0);
            expect(sample.bytesPerTick).toBeGreaterThan(0);
        } finally {
            meter.dispose();
        }
    });
});

describe('allocation windows', () => {
    it('shrinks a window that collected instead of reporting its delta', async () => {
        const meter = new Meter();
        try {
            const sample = await meter.allocation(driverOf(LIGHT), 64);
            expect(sample.ticks).toBeLessThan(64);
        } finally {
            meter.dispose();
        }
    });

    it('marks a window inexact when even the floor cannot stay clean', async () => {
        const meter = new Meter();
        try {
            // The suite runs at the default semi-space, so four of these cannot fit in it — which
            // is the case the `exact` flag exists for, and the one that must never read as a number.
            const sample = await meter.allocation(driverOf(HEAVY), 8);
            expect(sample.exact).toBe(false);
            expect(sample.ticks).toBe(4);
        } finally {
            meter.dispose();
        }
    });

    it('reports a quiet window as exact, at the size it was asked for', async () => {
        const meter = new Meter();
        try {
            const sample = await meter.allocation(
                driverOf(() => {
                    scratch[0] = (scratch[0] ?? 0) + 1;
                }),
                500,
            );
            expect(sample.exact).toBe(true);
            expect(sample.ticks).toBe(500);
        } finally {
            meter.dispose();
        }
    });
});

describe('drivers', () => {
    it('runs an async step exactly once per tick', async () => {
        const meter = new Meter();
        let calls = 0;
        try {
            await meter.time(
                asyncDriverOf(async () => {
                    calls += 1;
                    await Promise.resolve();
                }),
                17,
            );
        } finally {
            meter.dispose();
        }
        expect(calls).toBe(17);
    });
});

describe('window sizing', () => {
    it('trades tick count against tick cost to hold the wall-clock budget', () => {
        expect(ticksForBudget(1_000_000, 1000)).toBe(1000);
        // A tick costing a whole second gets the floor, not a fractional window.
        expect(ticksForBudget(1e9, 1000)).toBe(4);
        // A cheap tick is capped, so a cheap scenario cannot run for minutes.
        expect(ticksForBudget(1, 1000)).toBe(20_000);
        // A scenario that has not been timed yet must not produce an unbounded window.
        expect(ticksForBudget(Number.NaN)).toBe(4);
        expect(ticksForBudget(0)).toBe(4);
    });
});

// Core's tick, with nothing above it. Four questions: how cost grows with entity count, how it
// grows with script count, which pass owns the tick, and what the two roles actually differ by.

import { Loop, clearRuntime } from '@platform/core';
import type { Runtime, TickPasses } from '@platform/core';
import { driverOf, sized } from '../meter.js';
import type { Budget, Driver, Meter, Mode } from '../meter.js';
import type { Measurement } from '../report.js';
import { buildWorld, overlappingPairs } from '../worlds.js';
import type { WorldSpec } from '../worlds.js';

const SIM_RATE = 60;
const WARM_TICKS = 200;

/** Entity counts the curve is read off. The top of the range is a curve point, not a playable size. */
export const N_SWEEP = [100, 300, 1000, 3000, 10_000] as const;
export const SCRIPT_SWEEP = [0, 50, 150, 300] as const;

/** Every pass the loop drives, in tick order — the keys `passes` is stubbed through one at a time. */
const PASS_NAMES = [
    'starts',
    'input',
    'movement',
    'contacts',
    'regions',
    'countdowns',
    'update',
] as const;

/** A driver over its own loop, so no two measurements share a tick counter. */
function loopDriver(rt: Runtime): Driver {
    const loop = new Loop(rt);
    let tick = 0;
    return driverOf(() => {
        tick += 1;
        loop.step(tick);
    });
}

/**
 * The fastest of `rounds` timings.
 *
 * A difference between two of these is what the pass breakdown reports, and a mean carries whatever
 * the machine was doing at the time into that subtraction — where it can exceed the pass being
 * priced. The minimum is the run least interfered with, which is the one worth differencing.
 */
async function bestOf(meter: Meter, drive: Driver, ticks: number, rounds = 3): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rounds; i++) {
        best = Math.min(best, (await meter.time(drive, ticks)).nsPerTick);
    }
    return best;
}

interface Point {
    id: string;
    params: Record<string, string | number | boolean>;
    spec: Partial<WorldSpec>;
}

/** Measures one world in whichever mode the process was started for, then discards it. */
async function measure(
    meter: Meter,
    mode: Mode,
    budget: Budget,
    point: Point,
    heavy = false,
): Promise<Measurement> {
    const rt = buildWorld(point.spec);
    const pairs = overlappingPairs(rt);
    const drive = loopDriver(rt);
    await meter.warm(drive, WARM_TICKS);

    const base: Measurement = {
        id: point.id,
        scenario: point.id.split('.').slice(0, 2).join('.'),
        params: { ...point.params, overlappingPairs: pairs },
    };

    if (mode === 'gc') {
        // A heavy world gets fewer simulated seconds: at ten thousand entities one tick costs most
        // of a second of wall time, and the full budget would be an hour of them.
        const seconds = heavy ? Math.max(1, Math.round(budget.simSeconds / 3)) : budget.simSeconds;
        const sample = await meter.gcProfile(drive, seconds, SIM_RATE);
        clearRuntime();
        return {
            ...base,
            nsPerTick: sample.nsPerTick,
            bytesPerTick: sample.bytesPerTick,
            exactBytes: false,
            ticks: sample.simSeconds * sample.simRate,
            simSeconds: sample.simSeconds,
            gc: sample.gc,
        };
    }

    const ticks = await sized(meter, drive, budget.targetMs);
    const timing = await meter.time(drive, ticks);
    const alloc = await meter.allocation(drive, ticks);
    clearRuntime();
    return {
        ...base,
        nsPerTick: timing.nsPerTick,
        bytesPerTick: alloc.bytesPerTick,
        exactBytes: alloc.exact,
        ticks: timing.ticks,
        allocTicks: alloc.ticks,
    };
}

/** Tick cost against entity count: the curve that says whether growth is linear or not. */
export async function nSweep(
    meter: Meter,
    mode: Mode,
    budget: Budget,
    counts: readonly number[],
): Promise<Measurement[]> {
    const out: Measurement[] = [];
    for (const n of counts) {
        for (const colliders of [true, false]) {
            out.push(
                await measure(
                    meter,
                    mode,
                    budget,
                    {
                        id: `core.n-sweep.n=${n}${colliders ? '' : '.no-colliders'}`,
                        params: { entities: n, colliders, scripts: 0 },
                        spec: { entities: n, colliders },
                    },
                    n >= 3000,
                ),
            );
        }
    }
    return out;
}

/**
 * Tick cost against script count, with the contact walk out of the way.
 *
 * Colliders off on purpose: at any entity count where dispatch is measurable the walk is larger
 * than it, and a sweep that left it in would report the same number four times.
 */
export async function scriptSweep(
    meter: Meter,
    mode: Mode,
    budget: Budget,
    counts: readonly number[],
): Promise<Measurement[]> {
    const out: Measurement[] = [];
    for (const scripts of counts) {
        for (const scriptKind of ['ticker', 'writer'] as const) {
            out.push(
                await measure(meter, mode, budget, {
                    id: `core.script-sweep.${scriptKind}=${scripts}`,
                    params: { entities: 300, colliders: false, scripts, scriptKind },
                    spec: { entities: 300, colliders: false, scripts, scriptKind },
                }),
            );
        }
    }
    return out;
}

/**
 * What each pass costs, by removing one at a time from a live world.
 *
 * A/B inside one process rather than a table of separate timings: at the entity counts where this
 * matters one pass is three orders of magnitude larger than the rest, and a cross-run difference of
 * that shape is indistinguishable from the noise on the larger number.
 */
export async function passBreakdown(
    meter: Meter,
    budget: Budget,
    entities: number,
): Promise<Measurement> {
    const rt = buildWorld({ entities, colliders: true });
    const pairs = overlappingPairs(rt);
    const shipped = rt.passes;
    const drive = loopDriver(rt);
    await meter.warm(drive, WARM_TICKS);

    const ticks = await sized(meter, drive, budget.targetMs);
    const whole = await bestOf(meter, drive, ticks);

    const notes: Record<string, number> = { 'whole tick (us)': whole / 1000 };
    for (const name of PASS_NAMES) {
        const stubbed: TickPasses = { ...shipped, [name]: () => {} };
        rt.passes = stubbed;
        const without = await bestOf(meter, drive, ticks);
        rt.passes = shipped;
        notes[`without ${name} (us)`] = without / 1000;
        // Floored at zero: a pass whose removal made the tick no faster costs nothing measurable,
        // and a negative share reads as if removing work had made the loop slower.
        notes[`${name} share (%)`] = Math.max(0, ((whole - without) / whole) * 100);
    }

    clearRuntime();
    return {
        id: `core.pass-breakdown.n=${entities}`,
        scenario: 'core.pass-breakdown',
        params: { entities, colliders: true, overlappingPairs: pairs },
        nsPerTick: whole,
        ticks,
        notes,
    };
}

/**
 * What `isServer` costs, measured with the contact walk stubbed out.
 *
 * The flag gates the lag-ring capture and the set of locations that dispatch, and both are single-
 * digit microseconds — left in place, the walk is four orders of magnitude larger and the difference
 * between the roles is not visible at all.
 */
export async function roleSplit(
    meter: Meter,
    budget: Budget,
    entities: number,
): Promise<Measurement[]> {
    const out: Measurement[] = [];
    for (const isServer of [true, false]) {
        for (const contacts of [true, false]) {
            const rt = buildWorld({ entities, colliders: true, isServer });
            if (!contacts) rt.passes = { ...rt.passes, contacts: () => {} };
            const drive = loopDriver(rt);
            await meter.warm(drive, WARM_TICKS);
            const ticks = await sized(meter, drive, budget.targetMs);
            const timing = await meter.time(drive, ticks);
            const alloc = await meter.allocation(drive, ticks);
            clearRuntime();
            out.push({
                id: `core.role-split.${isServer ? 'server' : 'client'}${contacts ? '' : '.no-contacts'}`,
                scenario: 'core.role-split',
                params: { entities, isServer, contactsPass: contacts },
                nsPerTick: timing.nsPerTick,
                bytesPerTick: alloc.bytesPerTick,
                exactBytes: alloc.exact,
                ticks: timing.ticks,
                allocTicks: alloc.ticks,
            });
        }
    }
    return out;
}

// The three meters, and the validity rules that make their numbers mean anything.
//
// Two of them cannot run in one process. An exact byte figure needs a semi-space large enough that
// no collection runs inside the window, and a real scavenge count needs the semi-space a server
// actually ships with — so the mode is a process-level choice and `assertMode` refuses the wrong one.

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

/**
 * Runs `ticks` ticks of whatever is under measurement.
 *
 * One abstraction rather than a synchronous meter and an asynchronous twin: core's loop never
 * yields and a client's frame must, and two implementations of the shrink-and-retry rule below
 * would diverge the first time one of them was tuned.
 */
export type Driver = (ticks: number) => void | Promise<void>;

/** A driver over a step that returns nothing — core's loop, and the server's pump. */
export function driverOf(step: () => void): Driver {
    return (ticks) => {
        for (let i = 0; i < ticks; i++) step();
    };
}

/** A driver over a step that must be awaited — anything that turns a client's frame. */
export function asyncDriverOf(step: () => Promise<void>): Driver {
    return async (ticks) => {
        for (let i = 0; i < ticks; i++) await step();
    };
}

export interface GcTally {
    scavenge: number;
    markSweep: number;
    incremental: number;
    weakCb: number;
    totalMs: number;
    /** The longest single pause, which is the hitch a player would feel. */
    worstMs: number;
}

export interface TimingSample {
    nsPerTick: number;
    ticks: number;
}

export interface AllocationSample {
    bytesPerTick: number;
    ticks: number;
    /**
     * Whether no collection ran inside the window.
     *
     * False makes `bytesPerTick` a lower bound of unknown discount, never a measurement: a scavenge
     * inside the window reclaims bytes the heap delta then never saw.
     */
    exact: boolean;
}

export interface GcSample {
    simSeconds: number;
    simRate: number;
    nsPerTick: number;
    /** Net growth plus every drop a collection caused mid-run — a lower bound, by construction. */
    bytesPerTick: number;
    gc: GcTally;
}

export type Mode = 'alloc' | 'gc';

/** The one field a `gc` entry carries beyond the base shape: which collector ran. */
interface GcEntryDetail {
    detail?: { kind?: number };
}

const GC_KIND: Readonly<Record<number, 'scavenge' | 'markSweep' | 'incremental' | 'weakCb'>> = {
    1: 'scavenge',
    2: 'markSweep',
    4: 'incremental',
    8: 'weakCb',
    16: 'scavenge',
};

export function emptyTally(): GcTally {
    return { scavenge: 0, markSweep: 0, incremental: 0, weakCb: 0, totalMs: 0, worstMs: 0 };
}

/**
 * Turns the event loop once.
 *
 * Every drain in this file is preceded by one. A `gc` entry reaches an observer on a task, so a
 * window that blocked the loop and drained the instant it finished reads back empty — which is not
 * "nothing collected", it is "nothing has been delivered yet", and the two are indistinguishable
 * from the result.
 */
function turn(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

function hasExecArg(prefix: string): boolean {
    return process.execArgv.some((arg) => arg.startsWith(prefix));
}

/**
 * Refuses a run whose process flags contradict its mode.
 *
 * This is the guard for the three ways these numbers go quietly wrong: no `--expose-gc` and every
 * window starts on an unswept heap; a default semi-space under `alloc` and a scavenge lands inside
 * the window; and — the one that hides behind a plausible answer — a raised MAXIMUM alone. V8 sizes
 * the young generation adaptively and shrinks it on collection, so the forced sweep that establishes
 * a baseline hands the window a young generation of a megabyte or two however high the ceiling was.
 * Pinning the MINIMUM as well is what actually keeps a window collection-free.
 */
export function assertMode(mode: Mode): void {
    if (typeof globalThis.gc !== 'function' || !hasExecArg('--expose-gc')) {
        throw new Error('bench needs --expose-gc: without it no window has a swept baseline');
    }
    const resized = hasExecArg('--max-semi-space-size') || hasExecArg('--min-semi-space-size');
    if (mode === 'alloc') {
        if (!hasExecArg('--min-semi-space-size') || !hasExecArg('--max-semi-space-size')) {
            throw new Error(
                'alloc mode needs BOTH --min-semi-space-size=64 and --max-semi-space-size=64: the maximum alone is undone by the forced collection that starts every window, and the byte figure silently becomes a lower bound',
            );
        }
    } else if (resized) {
        throw new Error(
            'gc mode must run at the default semi-space size: a resized one suppresses the scavenges this mode exists to count',
        );
    }
}

/** How large V8 has grown the young generation, in MiB — recorded so a run is reproducible. */
export function newSpaceMiB(): number {
    const space = v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space');
    return (space?.space_size ?? 0) / 1024 / 1024;
}

function used(): number {
    return v8.getHeapStatistics().used_heap_size;
}

function collect(): void {
    const gc = globalThis.gc;
    // Twice: the first pass can resurrect through finalizers, and the second settles what it freed.
    gc?.();
    gc?.();
}

/** The floor a window may shrink to; below it, entering the loop costs more than the ticks do. */
const MIN_WINDOW = 4;

/**
 * Watches collections for the span of one window, and nothing longer.
 *
 * Per-window rather than per-run, which is the whole point. A single observer held across a session
 * of heavy scenarios stops delivering: entries pile up faster than they are drained, the timeline's
 * buffer for the type is exceeded, and later windows read back empty — reported as `exact: true`,
 * which is the one answer a discounted byte figure must never be given. Opened and disconnected
 * around each window, no observer ever holds more than that window's entries.
 */
class GcWatch {
    readonly #obs = new PerformanceObserver(() => {
        // Entries are read through takeRecords(); the callback exists only to open the subscription.
    });

    constructor() {
        this.#obs.observe({ entryTypes: ['gc'] });
    }

    /** Turns the loop so pending entries are delivered, then reports and closes. */
    async close(): Promise<GcTally> {
        await turn();
        const tally = emptyTally();
        for (const entry of this.#obs.takeRecords()) {
            // `takeRecords` is typed as the base entry, which carries no `detail`; a 'gc' entry is
            // always the node subclass that does, and the kind is the only field read off it.
            const { detail } = entry as unknown as GcEntryDetail;
            const kind = GC_KIND[detail?.kind ?? -1] ?? 'markSweep';
            tally[kind] += 1;
            tally.totalMs += entry.duration;
            tally.worstMs = Math.max(tally.worstMs, entry.duration);
        }
        this.#obs.disconnect();
        return tally;
    }
}

function add(into: GcTally, from: GcTally): void {
    into.scavenge += from.scavenge;
    into.markSweep += from.markSweep;
    into.incremental += from.incremental;
    into.weakCb += from.weakCb;
    into.totalMs += from.totalMs;
    into.worstMs = Math.max(into.worstMs, from.worstMs);
}

export class Meter {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- the class holds no state
    dispose(): void {}

    /** Sweeps the heap and lets the sweep's own entries drain before a watch is opened. */
    async #settle(): Promise<void> {
        collect();
        await turn();
    }

    /**
     * Runs up to `ticks` ticks without measuring, so the JIT and every lazy cache are warm.
     *
     * Capped by wall time as well as by count, and it is the wall cap that matters: at ten thousand
     * entities one tick is most of a second, and a fixed two hundred would spend minutes warming a
     * loop that tiers up inside its first pass. Returns what it actually ran.
     */
    async warm(drive: Driver, ticks: number, maxMs = 1500): Promise<number> {
        const deadline = process.hrtime.bigint() + BigInt(Math.round(maxMs * 1e6));
        let done = 0;
        let batch = 1;
        while (done < ticks && process.hrtime.bigint() < deadline) {
            const size = Math.min(batch, ticks - done);
            await drive(size);
            done += size;
            // Doubling keeps the clock read off the hot path for a cheap tick, and on it for a dear
            // one — where a fixed batch would overshoot the cap by most of a batch.
            batch = Math.min(batch * 2, 64);
        }
        return done;
    }

    /** Wall time per tick. Nothing about the heap is claimed here. */
    async time(drive: Driver, ticks: number): Promise<TimingSample> {
        collect();
        const start = process.hrtime.bigint();
        await drive(ticks);
        const elapsed = Number(process.hrtime.bigint() - start);
        return { nsPerTick: elapsed / ticks, ticks };
    }

    /**
     * Bytes allocated per tick, exact when the window stayed collection-free.
     *
     * A window that collected is retried a quarter as long rather than reported: shrinking is what
     * turns a heavy scenario back into a measurable one, and a scenario that cannot get clean even
     * at the floor is returned marked inexact rather than retried forever.
     */
    async allocation(drive: Driver, ticks: number): Promise<AllocationSample> {
        let window = Math.max(MIN_WINDOW, ticks);
        for (;;) {
            await this.#settle();
            const watch = new GcWatch();
            const before = used();
            await drive(window);
            const after = used();
            const tally = await watch.close();
            // Only a collection invalidates the delta; an incremental marking step frees nothing.
            const clean = tally.scavenge + tally.markSweep === 0;
            if (clean || window <= MIN_WINDOW) {
                return { bytesPerTick: (after - before) / window, ticks: window, exact: clean };
            }
            window = Math.max(MIN_WINDOW, Math.floor(window / 4));
        }
    }

    /**
     * Collections and pause time per simulated second, at the heap a server actually ships with.
     *
     * Chunked one simulated second at a time so the drain between chunks has a loop turn to happen
     * on, which is the only way these entries are ever seen.
     */
    async gcProfile(drive: Driver, simSeconds: number, simRate: number): Promise<GcSample> {
        await this.#settle();

        const tally = emptyTally();
        const before = used();
        let reclaimed = 0;
        let elapsed = 0n;

        for (let second = 0; second < simSeconds; second++) {
            // One watch per simulated second, for the same reason one per window: an observer that
            // outlives what it is measuring starts dropping what it was opened to see.
            const watch = new GcWatch();
            const chunkStart = used();
            const start = process.hrtime.bigint();
            await drive(simRate);
            elapsed += process.hrtime.bigint() - start;
            const chunkEnd = used();
            // A chunk that ended smaller than it started was collected; that drop is allocation the
            // net delta would otherwise never account for.
            if (chunkEnd < chunkStart) reclaimed += chunkStart - chunkEnd;
            add(tally, await watch.close());
        }

        const ticks = simSeconds * simRate;
        return {
            simSeconds,
            simRate,
            nsPerTick: Number(elapsed) / ticks,
            bytesPerTick: (used() - before + reclaimed) / ticks,
            gc: tally,
        };
    }
}

/**
 * A tick count that keeps one measurement near `targetMs` of wall time.
 *
 * Every scenario here spans four orders of magnitude of tick cost, so a fixed count either takes
 * minutes at the top of the range or measures noise at the bottom.
 */
export function ticksForBudget(nsPerTick: number, targetMs = 1500, min = 4, max = 20_000): number {
    if (!Number.isFinite(nsPerTick) || nsPerTick <= 0) return min;
    return Math.max(min, Math.min(max, Math.round((targetMs * 1e6) / nsPerTick)));
}

/**
 * A window size for `drive`, found by timing it first.
 *
 * Two probes rather than one fixed count, for the same reason the budget exists: a cheap tick needs
 * more than a single sample to size a window from, and a tick costing most of a second must not be
 * sampled again just to confirm what the first one already showed.
 */
export async function sized(meter: Meter, drive: Driver, targetMs: number): Promise<number> {
    const first = await meter.time(drive, 1);
    const ns = first.nsPerTick < 1e6 ? (await meter.time(drive, 16)).nsPerTick : first.nsPerTick;
    return ticksForBudget(ns, targetMs);
}

/** How long one measurement is allowed to take, which is the only thing `--quick` changes. */
export interface Budget {
    /** Wall time one timing window aims for. */
    targetMs: number;
    /** Simulated seconds one GC profile covers. */
    simSeconds: number;
}

export function budgetFor(quick: boolean): Budget {
    return quick ? { targetMs: 250, simSeconds: 1 } : { targetMs: 1200, simSeconds: 6 };
}

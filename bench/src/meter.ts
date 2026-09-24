// Two meters cannot run in one process: an exact byte figure needs a semi-space large enough that
// nothing collects, and a real scavenge count needs the shipped one — so the mode is process-level.

import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

/**
 * Runs `ticks` ticks of whatever is under measurement. One abstraction rather than a sync meter
 * and an async twin: two copies of the shrink-and-retry rule would diverge once one was tuned.
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
     * Whether no collection ran inside the window. False makes `bytesPerTick` a lower bound of
     * unknown discount, never a measurement: a scavenge reclaims bytes the heap delta never saw.
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
 * Turns the event loop once; every drain here is preceded by one. A `gc` entry reaches an
 * observer on a task, so a window that drained at once reads empty — not "nothing collected".
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
 * Refuses a run whose process flags contradict its mode. The subtle one is a raised MAXIMUM
 * alone: V8 shrinks the young generation on collection, so the MINIMUM is what pins a window.
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
 * Watches collections for one window and nothing longer. An observer held across a session stops
 * delivering, and later windows read empty — reported as `exact: true`.
 */
class GcWatch {
    readonly #obs = new PerformanceObserver(() => {
        // Entries are read through takeRecords(); the callback exists only to open the
        // subscription.
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
    /** A no-op: every `GcWatch` is closed by the measurement that opened it, so nothing outlives a call. */
    dispose(): void {}

    /** Sweeps the heap and lets the sweep's own entries drain before a watch is opened. */
    async #settle(): Promise<void> {
        collect();
        await turn();
    }

    /**
     * Runs up to `ticks` ticks unmeasured, so the JIT and every lazy cache are warm. Capped by wall
     * time as well as count: at ten thousand entities one tick is most of a second.
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
     * Bytes allocated per tick, exact when the window stayed collection-free. One that collected is
     * retried a quarter as long; one that cannot get clean is returned marked inexact.
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
     * Chunked one simulated second at a time, so the drain between chunks has a loop turn.
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

/** A tick count keeping one measurement near `targetMs`; tick cost spans four orders here. */
export function ticksForBudget(nsPerTick: number, targetMs = 1500, min = 4, max = 20_000): number {
    if (!Number.isFinite(nsPerTick) || nsPerTick <= 0) return min;
    return Math.max(min, Math.min(max, Math.round((targetMs * 1e6) / nsPerTick)));
}

/**
 * A window size for `drive`, found by timing it first. Two probes rather than one: a cheap tick
 * needs more than a sample, and a tick costing a second must not be sampled twice.
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

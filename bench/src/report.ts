// The result record and where it lands. One file per run, named so that a directory listing reads
// as a history: when, on what branch, at what commit, in which mode.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GcTally, Mode } from './meter.js';
import { gitStamp, hostStamp } from './stamp.js';
import type { GitStamp, HostStamp } from './stamp.js';

/** One simulated frame at 60 Hz, in nanoseconds — what every share-of-budget figure divides by. */
const FRAME_NS = 1e9 / 60;

export interface Measurement {
    /** Dot-separated: `core.n-sweep.n=1000`, so a diff between two runs can align on the name. */
    id: string;
    scenario: string;
    /** Whatever the scenario dials, recorded so a comparison can refuse mismatched inputs. */
    params: Readonly<Record<string, string | number | boolean>>;
    nsPerTick?: number;
    bytesPerTick?: number;
    /** False means `bytesPerTick` is a lower bound because a collection ran inside the window. */
    exactBytes?: boolean;
    /** Ticks the timing window ran. */
    ticks?: number;
    /**
     * Ticks the ALLOCATION window ran, which the shrink-to-clean rule makes a different number.
     *
     * Reported separately because conflating the two hides the shrink: a byte figure taken over four
     * ticks and one taken over four thousand answer differently, and a record that showed only the
     * timing count made the difference invisible.
     */
    allocTicks?: number;
    gc?: GcTally;
    simSeconds?: number;
    /** Free-form scenario output that is not a per-tick cost — a pass breakdown, a pair count. */
    notes?: Readonly<Record<string, number | string>>;
}

export interface RunFile {
    /** Bumped whenever a field changes meaning, so an old file is never silently misread. */
    schema: 1;
    startedAt: string;
    finishedAt: string;
    mode: Mode;
    durationMs: number;
    git: GitStamp;
    host: HostStamp;
    measurements: Measurement[];
}

function slug(value: string): string {
    return value.replaceAll(/[^\dA-Za-z-]+/g, '-').replace(/^-|-$/g, '') || 'none';
}

/** `2026-09-01T11-42-03Z`: an ISO instant a filename can hold, still sorting chronologically. */
function fileTimestamp(iso: string): string {
    return iso.replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
}

export function runFileName(run: Pick<RunFile, 'startedAt' | 'mode' | 'git'>): string {
    const tree = run.git.dirty ? `${run.git.shortCommit}-dirty` : run.git.shortCommit;
    return `${fileTimestamp(run.startedAt)}__${slug(run.git.branch)}__${slug(tree)}__${run.mode}.json`;
}

export interface RunInput {
    mode: Mode;
    startedAt: Date;
    measurements: Measurement[];
}

export function buildRun(input: RunInput): RunFile {
    const finished = new Date();
    return {
        schema: 1,
        startedAt: input.startedAt.toISOString(),
        finishedAt: finished.toISOString(),
        mode: input.mode,
        durationMs: finished.getTime() - input.startedAt.getTime(),
        git: gitStamp(),
        host: hostStamp(),
        measurements: input.measurements,
    };
}

/** Writes the run under `dir`, creating it if this is the first one, and answers the path. */
export function writeRun(run: RunFile, dir: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, runFileName(run));
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    return path;
}

function share(nsPerTick: number | undefined): string {
    return nsPerTick === undefined ? '' : `${((nsPerTick / FRAME_NS) * 100).toFixed(2)}%`;
}

function round(value: number | undefined, places: number): number | string {
    return value === undefined ? '' : Number(value.toFixed(places));
}

/** The same numbers as the JSON, arranged for a terminal — a run is usually read before it is filed. */
export function printRun(run: RunFile): void {
    const rows = run.measurements.map((m) => ({
        id: m.id,
        'µs/tick': round(m.nsPerTick === undefined ? undefined : m.nsPerTick / 1000, 2),
        '%frame': share(m.nsPerTick),
        'B/tick': m.bytesPerTick === undefined ? '' : Math.round(m.bytesPerTick),
        exact: m.exactBytes ?? '',
        allocTicks: m.allocTicks ?? '',
        scav: m.gc?.scavenge ?? '',
        major: m.gc === undefined ? '' : m.gc.markSweep + m.gc.incremental,
        'gcMs/s':
            m.gc === undefined || m.simSeconds === undefined
                ? ''
                : Number((m.gc.totalMs / m.simSeconds).toFixed(2)),
        worstGcMs: m.gc === undefined ? '' : Number(m.gc.worstMs.toFixed(2)),
    }));
    console.table(rows);

    for (const m of run.measurements) {
        if (m.notes === undefined) continue;
        console.log(`\n${m.id}`);
        console.table(m.notes);
    }
}

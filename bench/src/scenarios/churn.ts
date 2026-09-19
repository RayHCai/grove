// A steady world sees neither cost: a slot table recycles only on a destroy, and a capture buffer
// regrows only when the entity count passes what it holds.

import { Loop, clearRuntime } from '@platform/core';
import type { EntityId, Runtime } from '@platform/core';
import { driverOf, sized } from '../meter.js';
import type { Budget, Meter } from '../meter.js';
import type { Measurement } from '../report.js';
import { buildWorld, overlappingPairs, spawnAt } from '../worlds.js';

const WARM_TICKS = 100;
const BASE_ENTITIES = 200;
const SPACING = 4;
/** `@platform/core`'s spawn ceiling, which its barrel does not export. */
const MAX_ENTITIES = 10_000;
/** What `sized` spends probing before it returns a window: one tick, then sixteen. */
const PROBE_TICKS = 17;
/**
 * Windows one `run` may drive: timing, allocation, and allocation's retry chain.
 * The retry chain converges to four thirds of one window, so the worst case is 1 + 4/3. Four.
 */
const WINDOWS_PER_RUN = 4;
/**
 * One grid width for the base world and every later spawn alike: they must share an index space
 * or two indexes land on one point, and two colliderless bodies there read as an overlap.
 */
const GRID_SIDE = 512;

/** Deterministic, because a benchmark that samples a different world each run compares nothing. */
function victim(ids: readonly EntityId[], nth: number): EntityId | undefined {
    return ids[nth % Math.max(1, ids.length)];
}

interface Churn {
    id: string;
    params: Record<string, string | number | boolean>;
    /** Runs before each tick, and is counted as part of that tick's cost. */
    mutate: (rt: Runtime, tick: number) => void;
}

async function run(
    meter: Meter,
    budget: Budget,
    world: Runtime,
    churn: Churn,
    maxTicks = Infinity,
): Promise<Measurement> {
    const loop = new Loop(world);
    let tick = 0;
    const drive = driverOf(() => {
        tick += 1;
        churn.mutate(world, tick);
        loop.step(tick);
    });

    await meter.warm(drive, WARM_TICKS);
    const ticks = Math.min(await sized(meter, drive, budget.targetMs), maxTicks);
    const timing = await meter.time(drive, ticks);
    const alloc = await meter.allocation(drive, ticks);
    const live = world.entities.liveIds().length;
    const pairs = overlappingPairs(world);
    clearRuntime();

    return {
        id: churn.id,
        scenario: 'churn',
        params: { ...churn.params, liveAtEnd: live, overlappingPairs: pairs },
        nsPerTick: timing.nsPerTick,
        bytesPerTick: alloc.bytesPerTick,
        exactBytes: alloc.exact,
        ticks: timing.ticks,
        allocTicks: alloc.ticks,
    };
}

/**
 * The two shapes, colliders off so the O(n²) walk does not drown what is measured.
 * `rising` is the one the capture buffers care about: only it prices the growth policy.
 */
export async function churnScenarios(
    meter: Meter,
    budget: Budget,
    perTick: number,
): Promise<Measurement[]> {
    const empty = {
        entities: BASE_ENTITIES,
        colliders: false,
        spacing: SPACING,
        gridSide: GRID_SIDE,
    };

    // Each scenario walks its own monotonic index, so no two bodies ever land on one grid cell.
    let replaced = BASE_ENTITIES;
    const flat = await run(meter, budget, buildWorld(empty), {
        id: `churn.flat.replace=${perTick}`,
        params: { entities: BASE_ENTITIES, replacedPerTick: perTick, colliders: false },
        mutate: (rt, tick) => {
            const ids = rt.entities.liveIds();
            for (let k = 0; k < perTick; k++) {
                const doomed = victim(ids, tick * perTick + k);
                if (doomed !== undefined) rt.entityManager.destroy(doomed);
                spawnAt(rt, replaced % (GRID_SIDE * GRID_SIDE), GRID_SIDE, SPACING);
                replaced += 1;
            }
        },
    });

    // A rising world spawns on every tick of every window, so the run is bounded by the entity cap
    // rather than by the time budget — and the faster a tick gets, the more ticks the budget buys.
    // Stated in the result, because a window silently cut short is a different measurement.
    const spawningTicks = WARM_TICKS + PROBE_TICKS;
    const ceiling = Math.floor(
        ((MAX_ENTITIES - BASE_ENTITIES) / perTick - spawningTicks) / WINDOWS_PER_RUN,
    );

    let next = BASE_ENTITIES;
    const rising = await run(
        meter,
        budget,
        buildWorld(empty),
        {
            id: `churn.rising.spawn=${perTick}`,
            params: {
                entities: BASE_ENTITIES,
                spawnedPerTick: perTick,
                colliders: false,
                tickCeiling: ceiling,
            },
            mutate: (rt) => {
                for (let k = 0; k < perTick; k++) {
                    spawnAt(rt, next, GRID_SIDE, SPACING);
                    next += 1;
                }
            },
        },
        ceiling,
    );

    return [flat, rising];
}

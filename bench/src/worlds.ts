// Core-only worlds, built to a spec rather than authored, so entity count and script count are
// dials rather than properties of a particular game.

import { bounds } from '@platform/math';
import { loadGame } from '@platform/core';
import type { EntityId, Entity, Runtime } from '@platform/core';
import { BenchCollider, BenchTicker, BenchWriter } from './scripts.js';

/** Which fixture a world's scripted entities carry. */
export type ScriptKind = 'ticker' | 'writer' | 'collider';

export interface WorldSpec {
    entities: number;
    /** Whether bodies carry a collider. The contact walk visits every entity either way. */
    colliders: boolean;
    /** How many of the entities carry a script, from slot 0 up. */
    scripts: number;
    scriptKind: ScriptKind;
    isServer: boolean;
    /**
     * Grid pitch in world units.
     *
     * Load-bearing, not decoration. Half-extents of zero compare equal, so colliderless bodies at
     * one point register as overlapping pairs — a world stacked at the origin measures the pair
     * DISPATCH and reads as if the walk itself had got slower.
     */
    spacing: number;
    /**
     * Cells per grid row, or 0 to derive one that squares off this world's entity count.
     *
     * A scenario that keeps spawning must set it: a derived width changes as the world grows, so
     * one index maps to two different points and, worse, two indexes map to one.
     */
    gridSide: number;
}

export const DEFAULT_SPEC: WorldSpec = {
    entities: 300,
    colliders: true,
    scripts: 0,
    scriptKind: 'ticker',
    isServer: true,
    spacing: 4,
    gridSide: 0,
};

const HALF_EXTENT = 0.5;
const TAG = 'bench';

const FIXTURES = {
    ticker: BenchTicker,
    writer: BenchWriter,
    collider: BenchCollider,
} as const;

/** The grid width a spec asks for, or one that squares off its entity count. */
export function sideOf(spec: Pick<WorldSpec, 'entities' | 'gridSide'>): number {
    return spec.gridSide > 0 ? spec.gridSide : Math.max(1, Math.ceil(Math.sqrt(spec.entities)));
}

/** How far a world reaches: enough to hold its grid, with a row spare for whatever it spawns next. */
function extent(spec: WorldSpec): number {
    const side = sideOf(spec);
    const rows = Math.ceil(spec.entities / side) + 1;
    return Math.max(1000, (Math.max(side, rows) + 1) * spec.spacing);
}

/** Where the nth body sits — a square grid, so neighbours are `spacing` apart on both axes. */
export function gridPosition(index: number, side: number, spacing: number): [number, number] {
    return [(index % side) * spacing, Math.floor(index / side) * spacing];
}

export function buildWorld(partial: Partial<WorldSpec> = {}): Runtime {
    const spec = { ...DEFAULT_SPEC, ...partial };
    const half = extent(spec);
    const rt = loadGame({ bounds: bounds(-half, half, half, -half), role: 'server' });
    // After `loadGame`, which reads `role` off the manifest: this is the dial the pass table and the
    // lag-ring capture branch on, and the two roles are meant to be comparable in one process.
    rt.isServer = spec.isServer;

    const side = sideOf(spec);
    const klass = FIXTURES[spec.scriptKind];
    for (let i = 0; i < spec.entities; i++) {
        const [x, y] = gridPosition(i, side, spec.spacing);
        const entity = rt.gameInstance.spawn('bench', x, y);
        if (spec.colliders) {
            entity.collider = {
                enabled: true,
                isTrigger: false,
                bounds: bounds(-HALF_EXTENT, HALF_EXTENT, HALF_EXTENT, -HALF_EXTENT),
            };
        }
        entity.tag(TAG);
        if (i < spec.scripts) entity.addScript(klass as never);
    }
    return rt;
}

/**
 * How many pairs this world's contact walk reports.
 *
 * Recorded beside every scenario, because a pair count is an input to the measurement and not a
 * result of it: two worlds of equal size and different overlap are not comparable.
 */
export function overlappingPairs(rt: Runtime): number {
    const out: Array<[EntityId, EntityId]> = [];
    return rt.wired.contacts.pairs(out).length;
}

/** Spawns one more body on the same grid, for the scenarios that grow a world as they run. */
export function spawnAt(rt: Runtime, index: number, side: number, spacing: number): Entity {
    const [x, y] = gridPosition(index, side, spacing);
    return rt.gameInstance.spawn('bench', x, y);
}

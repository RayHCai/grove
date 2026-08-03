// The drifter simulation. PURE: no React, no DOM, and no `IRenderer`.
//
// It decides WHERE things are; the caller decides what to draw. That split is the whole point of
// the file — `step()` is a plain function over plain data, so the spawn-travel-despawn rule is
// testable in Node with no canvas and no clock (mirroring how @platform/renderer keeps its
// arithmetic out of the backend).
//
// Coordinates are WORLD space throughout: origin at stage center, y-UP, world px (§3).

import type { Bounds } from '@platform/math';

/** A sprite crossing the stage. `id` is the caller's renderer handle, opaque here. */
export interface Drifter<Id> {
    id: Id;
    /** World px. `y` is fixed for this drifter's whole life; only `x` advances. */
    x: number;
    y: number;
    /** World px per second, positive — every drifter travels left to right. */
    speed: number;
    /** Degrees, CCW-positive. Advanced by `spin` so the leaf tumbles as it crosses. */
    rotation: number;
    /** Degrees per second. */
    spin: number;
}

/** What one `step()` produced: who moved, and who left the stage. */
export interface StepResult<Id> {
    /** Still on stage, with `x` and `rotation` already advanced. */
    alive: Array<Drifter<Id>>;
    /** Passed the right edge this step. The caller destroys these. */
    exited: Array<Drifter<Id>>;
}

/**
 * Half a sprite's width, in world px, used as the off-stage margin.
 *
 * A drifter spawns this far LEFT of the viewport's left edge and is retired this far RIGHT of its
 * right edge, so it slides fully into view and fully out rather than popping at either boundary.
 */
export const EDGE_MARGIN = 32;

/** Default travel speed, world px per second — about four seconds across a 960px stage. */
export const DEFAULT_SPEED = 240;

/** Default tumble rate, degrees per second. */
export const DEFAULT_SPIN = 90;

/**
 * The world x a drifter enters from: fully off the viewport's left edge.
 *
 * Deliberately derived from the LIVE viewport rather than the design stage, so a resized window
 * (or a zoomed camera) spawns at the edge the player can actually see.
 */
export function spawnX(viewport: Bounds): number {
    return viewport.left - EDGE_MARGIN;
}

/** The world x past which a drifter has fully left the stage. */
export function exitX(viewport: Bounds): number {
    return viewport.right + EDGE_MARGIN;
}

/**
 * Advances every drifter by `dt` seconds and partitions them.
 *
 * Returns new arrays and MUTATES each drifter in place — the caller holds a stable array of
 * objects across frames, so reallocating a drifter per frame would churn for nothing.
 *
 * `dt` is clamped at zero: a backwards clock (a paused tab resuming, a clock adjustment) must not
 * drag drifters leftwards, and the frame loop already caps the upper end.
 */
export function step<Id>(
    drifters: ReadonlyArray<Drifter<Id>>,
    dt: number,
    viewport: Bounds,
): StepResult<Id> {
    const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const limit = exitX(viewport);

    const alive: Array<Drifter<Id>> = [];
    const exited: Array<Drifter<Id>> = [];

    for (const drifter of drifters) {
        drifter.x += drifter.speed * elapsed;
        // Kept in [0, 360) so the value stays readable in the HUD and never drifts toward the
        // precision loss a monotonically growing angle would eventually hit.
        drifter.rotation = (drifter.rotation + drifter.spin * elapsed) % 360;
        (drifter.x > limit ? exited : alive).push(drifter);
    }

    return { alive, exited };
}

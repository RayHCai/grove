// The leaf rules, as arithmetic and nothing else.
//
// It holds no entity, no runtime and no socket, which is what lets the tick rule and the scoring
// rule be tested in Node with neither a world nor a clock. `game.ts` is the only file that turns
// these numbers into entities.

import type { Bounds } from '@platform/math';
import {
    BADGE_BONUS,
    HARVEST_POINTS,
    LEAF_HALF,
    LEAF_SCALE,
    POP_POINTS,
    RIPE_MULTIPLIER,
} from '../shared.js';

/**
 * Half a sprite's width, in world px, used as the off-stage margin.
 *
 * A leaf spawns this far left of the world's left edge and is retired this far right of its right
 * edge, so it slides fully into view and fully out rather than popping.
 */
export const EDGE_MARGIN = 32;

/** World px per second. About four seconds to cross a 960px stage. */
export const LEAF_SPEED = 240;

/** Degrees per second, CCW-positive. */
export const LEAF_SPIN = 90;

/** How much wider a leaf draws while it is ripe, so `bonus` is legible without a second sprite. */
export const RIPE_SCALE = LEAF_SCALE * 1.35;

/**
 * The owner badge parented above each leaf: how big, how far above, and how solid.
 *
 * `marker.png` is 8x8, so scale 2 draws it at 16 world px — a third of a leaf, large enough to read
 * as a colour at a glance without competing with the art. It is kept fully opaque because it exists
 * to be identified, and it does not inherit its parent's rotation, so it rides upright over a
 * tumbling leaf.
 */
export const MARKER_SCALE = 2;
export const MARKER_OFFSET_Y = 34;
export const MARKER_OPACITY = 1;

/** Draw order: the badge sits above its leaf. */
export const LEAF_LAYER = 10;
export const MARKER_LAYER = 11;

/** The world x a leaf enters from, fully off the left edge. */
export function spawnX(bounds: Bounds): number {
    return bounds.left - EDGE_MARGIN;
}

/** The world x past which a leaf has fully left the stage. */
export function exitX(bounds: Bounds): number {
    return bounds.right + EDGE_MARGIN;
}

/** Clamps a click to the stage, so a leaf can never enter above or below the visible world. */
export function clampToWorld(y: number, bounds: Bounds): number {
    if (!Number.isFinite(y)) return 0;
    return Math.min(Math.max(y, bounds.bottom), bounds.top);
}

/**
 * The band a dropped leaf may enter at, inset so a leaf never rides the very edge of the stage.
 *
 * The inset is the harvest half-box: an avatar cannot reach above the world's top edge, so a leaf
 * spawned there would be uncatchable rather than merely hard.
 */
export function dropBand(bounds: Bounds): { low: number; high: number } {
    return { low: bounds.bottom + LEAF_HALF, high: bounds.top - LEAF_HALF };
}

export interface LeafStep {
    x: number;
    rotation: number;
}

/**
 * One tick of drift.
 *
 * Rotation is kept in [0, 360) so the value stays readable and never drifts toward the precision
 * loss a monotonically growing angle would eventually hit.
 */
export function stepLeaf(x: number, rotation: number, dt: number): LeafStep {
    return {
        x: x + LEAF_SPEED * dt,
        rotation: (rotation + LEAF_SPIN * dt) % 360,
    };
}

/** Whether a leaf at `x` has finished crossing and should be destroyed. */
export function hasExited(x: number, bounds: Bounds): boolean {
    return x > exitX(bounds);
}

/**
 * What one harvest is worth.
 *
 * Ripening multiplies and the badge adds, in that order: the badge is a flat reward for crossing
 * the stage to the leaf that is yours, and multiplying it too would make one lucky leaf decide a
 * round. A click is worth {@link POP_POINTS} and takes neither — popping is the cheap steal, not
 * the way to win.
 */
export function harvestValue(opts: { ripe: boolean; badgedForHarvester: boolean }): number {
    const base = opts.ripe ? HARVEST_POINTS * RIPE_MULTIPLIER : HARVEST_POINTS;
    return base + (opts.badgedForHarvester ? BADGE_BONUS : 0);
}

export function popValue(): number {
    return POP_POINTS;
}

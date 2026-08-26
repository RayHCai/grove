// The drifter rule, as arithmetic and nothing else.
//
// It holds no entity, no runtime and no socket, which is what lets the tick rule be tested in Node
// with neither a world nor a clock. `game.ts` is the only file that turns these numbers into
// entities.

import type { Bounds } from '@platform/math';

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

/** `leaf.png` is 16x16, so pixel art needs scaling up to be visible on a 960px stage. */
export const LEAF_SCALE = 3;

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

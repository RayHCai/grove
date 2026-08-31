// Pure, and everything takes plain numbers, so the per-frame cull scan and the editor's
// `worldBoundsOf` share one implementation without either store depending on the other.
//
// No ancestor walk anywhere: rotation and scale stop at the node that declares them, so a node's
// AABB needs only its own size, scale, anchor and rotation plus its resolved world position —
// which is what makes culling a flat typed-array scan rather than a tree traversal.
//
// Every rect here is world space, y-up: `top > bottom`.

import type { Bounds, Size } from '@platform/math';
import { DEG2RAD, bounds, boundsExpand, boundsOverlap, boundsSet, cos, sin } from '@platform/math';

/** Default `cullMargin`, in world px. */
export const DEFAULT_CULL_MARGIN = 64;

/** Scratch for the margin-expanded viewport: the cull test runs per node per frame. */
const expandedViewport = bounds();

/** Collapses `-0` to `0`, since `Object.is(-0, 0)` is false and a returned edge should be plain. */
function plusZero(value: number): number {
    return value === 0 ? 0 : value;
}

/** The quarter turn `degrees` names, or -1 when it is not a multiple of 90. */
function quarterTurn(degrees: number): number {
    const quarters = degrees / 90;
    if (!Number.isInteger(quarters)) return -1;
    return ((quarters % 4) + 4) % 4;
}

/**
 * `cos` of an angle in degrees, exact at multiples of 90.
 *
 * `90 * DEG2RAD` is not π/2, so `cos` of it is 6.1e-17 rather than 0 however exact the cosine is.
 * Without these arms that residue leaks into every edge of a quarter-turned AABB — the commonest
 * authored rotation.
 */
function cosDeg(degrees: number): number {
    switch (quarterTurn(degrees)) {
        case 0:
            return 1;
        case 1:
        case 3:
            return 0;
        case 2:
            return -1;
        default:
            return cos(degrees * DEG2RAD);
    }
}

/** `sin` of an angle in DEGREES, exact at multiples of 90. See {@link cosDeg}. */
function sinDeg(degrees: number): number {
    switch (quarterTurn(degrees)) {
        case 0:
        case 2:
            return 0;
        case 1:
            return 1;
        case 3:
            return -1;
        default:
            return sin(degrees * DEG2RAD);
    }
}

/**
 * Local AABB of a sprite, y-up, relative to the node's own origin: the size scaled per-axis,
 * offset so the 0..1 `anchor` sits at the origin.
 *
 * `anchor` is y-down inside the art, matching a texture's row order, while the rect is y-up —
 * hence the sign flip on the vertical pair. A negative scale mirrors the rect about the origin,
 * and the result is renormalized so `left <= right` and `bottom <= top` always hold.
 */
export function spriteLocalBounds(
    size: Size,
    scaleX: number,
    scaleY: number,
    anchorX: number,
    anchorY: number,
    out: Bounds = bounds(),
): Bounds {
    const w = size.width * scaleX;
    const h = size.height * scaleY;

    const left = -anchorX * w;
    const right = left + w;
    const top = anchorY * h;
    const bottom = top - h;

    return boundsSet(
        out,
        plusZero(Math.min(left, right)),
        plusZero(Math.max(left, right)),
        plusZero(Math.max(top, bottom)),
        plusZero(Math.min(top, bottom)),
    );
}

/** A zero-extent rect at the origin — a group's local bounds. */
export function emptyLocalBounds(out: Bounds = bounds()): Bounds {
    return boundsSet(out, 0, 0, 0, 0);
}

/**
 * Exact half-extents of the AABB of a rect of half-extents (hx, hy) rotated by `degrees`.
 *
 * The absolute values are why the rotation's sign and quadrant drop out: -45, 45 and 135 all
 * expand identically, and a flipped rect's negative half-extents read as magnitudes.
 */
export function rotatedHalfExtents(
    hx: number,
    hy: number,
    degrees: number,
): { hx: number; hy: number } {
    const ax = Math.abs(hx);
    const ay = Math.abs(hy);
    const c = Math.abs(cosDeg(degrees));
    const s = Math.abs(sinDeg(degrees));
    return { hx: c * ax + s * ay, hy: s * ax + c * ay };
}

/**
 * Local bounds rotated about the node origin, then translated to (worldX, worldY). y-up.
 *
 * The pivot is the node's origin — its anchor point — not the rect's center, so an off-center
 * rect has its center swept around the origin as well as its extents expanded.
 */
export function worldAabb(
    local: Bounds,
    degrees: number,
    worldX: number,
    worldY: number,
    out: Bounds = bounds(),
): Bounds {
    // A caller-built rect may be inverted, and a half-extent must never come out negative.
    const minX = Math.min(local.left, local.right);
    const maxX = Math.max(local.left, local.right);
    const minY = Math.min(local.bottom, local.top);
    const maxY = Math.max(local.bottom, local.top);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const hx = (maxX - minX) / 2;
    const hy = (maxY - minY) / 2;

    const c = cosDeg(degrees);
    const s = sinDeg(degrees);

    const rotX = cx * c - cy * s;
    const rotY = cx * s + cy * c;

    const ac = Math.abs(c);
    const as = Math.abs(s);
    const halfW = ac * hx + as * hy;
    const halfH = as * hx + ac * hy;

    const centerX = worldX + rotX;
    const centerY = worldY + rotY;

    return boundsSet(
        out,
        plusZero(centerX - halfW),
        plusZero(centerX + halfW),
        plusZero(centerY + halfH),
        plusZero(centerY - halfH),
    );
}

/**
 * `true` when the node should be drawn: its world AABB overlaps the margin-expanded viewport.
 *
 * Takes no scale or zoom so that it cannot apply one — the viewport arrives in world coords, so
 * `cullMargin` means the same slack at every zoom. Touching edges count as overlapping, since a
 * sprite flush against the viewport edge contributes a visible pixel column. Which kinds are
 * exempt from culling is the caller's concern; this answers only the geometric question.
 */
export function isVisibleInViewport(
    worldBounds: Bounds,
    viewport: Bounds,
    cullMargin: number,
): boolean {
    // A NaN margin would cull the whole scene, which reads as a black screen rather than as a bad
    // argument. A negative one is clamped rather than honoured as an inset: an inset deeper than
    // the viewport's half-extent inverts the axis, and `boundsOverlap` re-normalizes it into a
    // rect that grows without bound. Clamping keeps the test monotonic in the margin.
    const margin = Number.isFinite(cullMargin) && cullMargin > 0 ? cullMargin : 0;
    return boundsOverlap(worldBounds, boundsExpand(expandedViewport, viewport, margin));
}

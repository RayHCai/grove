// PURE. Local bounds, the rotated world AABB, and the cull test (§8).
//
// Everything here takes PLAIN NUMBERS — no transform store, no node store, no `NodeId`. That
// is what lets the per-frame cull scan and the public `worldBoundsOf` (the editor needs it for
// marquee hit-tests) share one implementation without either store depending on the other, and
// it keeps `import/no-cycle` trivially satisfied.
//
// NO ANCESTOR WALK ANYWHERE. Rotation and scale stop at the node that declares them (§5), so a
// node's AABB is a function of its own texture size, scale, anchor and rotation plus its
// already-resolved world position. That is the entire reason culling is a flat typed-array scan
// rather than a tree traversal.
//
// Every rect here is WORLD space, y-up: `top > bottom`.

import type { Bounds, Size } from '@platform/math';
import { DEG2RAD, bounds, boundsExpand, boundsOverlap, boundsSet } from '@platform/math';

/** Default `cullMargin`, in WORLD px (§8). */
export const DEFAULT_CULL_MARGIN = 64;

/**
 * Scratch for the margin-expanded viewport.
 *
 * `isVisibleInViewport` runs once per node per frame and must not allocate. Nothing escapes
 * the call, so one module-level rect is safe — but it does mean the function is not reentrant,
 * which is fine because it neither calls out nor yields.
 */
const expandedViewport = bounds();

/**
 * Collapses `-0` to `0`.
 *
 * `-anchorX * w` yields `-0` whenever `anchorX` or the scaled size is zero, and
 * `Object.is(-0, 0)` is false. Arithmetic and the overlap tests are unaffected by the sign of
 * zero; this exists so a returned edge is the plain zero a caller can recognize.
 */
function plusZero(value: number): number {
    return value === 0 ? 0 : value;
}

/**
 * The quarter turn `degrees` names — 0, 1, 2 or 3 — or -1 when it is not a multiple of 90.
 *
 * Normalized for negative and multi-turn angles alike, so -90 and 630 both land on 3.
 */
function quarterTurn(degrees: number): number {
    const quarters = degrees / 90;
    if (!Number.isInteger(quarters)) return -1;
    return ((quarters % 4) + 4) % 4;
}

/**
 * `cos` of an angle in DEGREES, EXACT at multiples of 90.
 *
 * `Math.cos(90 * DEG2RAD)` is 6.1e-17 rather than 0, and that residue leaks into every edge of
 * a quarter-turned AABB — a 10x20 sprite at 90 degrees would report a half-extent of
 * 10.000000000000002. Quarter turns are the overwhelmingly common authored rotation, so they
 * are answered exactly instead of through the transcendental.
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
            return Math.cos(degrees * DEG2RAD);
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
            return Math.sin(degrees * DEG2RAD);
    }
}

/**
 * Local AABB of a sprite, y-up, relative to the node's own origin: the texture size
 * scaled per-axis, then offset so the 0..1 `anchor` sits at the origin.
 *
 * The derivation, with `w = width * scaleX` and `h = height * scaleY`. `anchor` is y-DOWN
 * inside the art — 0 is its top edge, matching a texture's own row order — while the rect is
 * y-up, which is where the sign flip on the vertical pair comes from:
 *
 *     left = -anchorX * w      right  = left + w
 *     top  =  anchorY * h      bottom = top - h
 *
 * So a 64x32 texture at scale 1 is `{left: -32, right: 32, top: 16, bottom: -16}` centered;
 * `{left: 0, right: 64, top: 0, bottom: -32}` at anchor `{0, 0}`, where the origin is the
 * art's TOP-LEFT and the art therefore extends DOWNWARD; and `{left: -64, right: 0, top: 32,
 * bottom: 0}` at anchor `{1, 1}`, the bottom-right.
 *
 * A negative scale — the horizontal flip of §5 — makes `w` or `h` negative, which mirrors the
 * rect about the origin. The result is renormalized, so `left <= right` and `bottom <= top`
 * always hold.
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

/** A zero-extent rect at the origin — a group's local bounds (§8). */
export function emptyLocalBounds(out: Bounds = bounds()): Bounds {
    return boundsSet(out, 0, 0, 0, 0);
}

/**
 * Exact half-extents of the AABB of a rect of half-extents (hx, hy) rotated by `degrees`.
 *
 *     hx' = |cos t| * hx + |sin t| * hy
 *     hy' = |sin t| * hx + |cos t| * hy
 *
 * The absolute values are why the rotation's sign and quadrant drop out: -45, 45 and 135 all
 * expand identically. Negative inputs are read as magnitudes, so half-extents taken from a
 * flipped rect still produce a normalized answer.
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
 * The pivot is the node's ORIGIN — the anchor point — not the rect's center, so an off-center
 * rect has its center swept around the origin as well as its extents expanded. Rotation is
 * CCW-positive in this y-up space, hence the standard `(x cos - y sin, x sin + y cos)`.
 * For a centered anchor the center terms vanish and this reduces to §8's two-line formula.
 */
export function worldAabb(
    local: Bounds,
    degrees: number,
    worldX: number,
    worldY: number,
    out: Bounds = bounds(),
): Bounds {
    // Read min/max rather than trusting the edge names: a caller-built rect may be inverted,
    // and a half-extent must never come out negative.
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
 * `true` when the node should be DRAWN: its world AABB overlaps the margin-expanded viewport.
 *
 * `cullMargin` is WORLD px (§8), and this function is given no scale or zoom precisely so that
 * it cannot apply one — the viewport arrives already in world coords, so 64 means the same
 * slack at every zoom level. A CSS-px margin would pop sprites in a zoomed-out editor view and
 * over-draw in a zoomed-in game view.
 *
 * Touching edges count as overlapping, matching `boundsOverlap`: a sprite flush against the
 * viewport edge contributes a visible pixel column.
 *
 * The kinds that are never culled — groups, UI text, `neverCull` nodes (§8) — are the caller's
 * concern; this answers only the geometric question.
 */
export function isVisibleInViewport(
    worldBounds: Bounds,
    viewport: Bounds,
    cullMargin: number,
): boolean {
    // A NaN margin would poison every comparison and cull the whole scene, which reads as a
    // black screen rather than as a bad argument. No slack is the safe reading.
    //
    // A NEGATIVE margin is clamped to 0 rather than honoured as an inset. `cullMargin` is
    // documented as "slack ADDED to the viewport" (§8), so an inset has no specified meaning —
    // and passing one through is actively unsafe: `boundsExpand` shrinks each axis toward the
    // interior, and an inset deeper than the viewport's half-extent INVERTS the axis. Because
    // `boundsOverlap` re-normalizes min/max, the inverted rect reads as a valid one that then
    // GROWS without bound as the inset deepens. A margin of -1100 against a 200x100 viewport
    // draws a node 1000 world px off screen. Clamping keeps the test monotonic in the margin:
    // more slack never culls more, less slack never draws more.
    const margin = Number.isFinite(cullMargin) && cullMargin > 0 ? cullMargin : 0;
    return boundsOverlap(worldBounds, boundsExpand(viewport, margin, expandedViewport));
}

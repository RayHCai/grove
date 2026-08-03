// Rectangles. `Bounds` is edge-named rather than origin+size, matching api_spec.ts:57.
//
// ORIENTATION: the edge names are read in the space that produced them, so `top` and
// `bottom` compare differently depending on the space's y direction:
//
//   world  (y-up)    top    >  bottom    — `viewport`, `worldBoundsOf`, `localBoundsOf`
//   screen (y-down)  bottom >  top       — `stageRect`, `screenBoundsOf`
//
// Nothing here assumes a direction: `boundsWidth` and `boundsHeight` return the absolute
// extent, and `boundsOverlap` compares each axis against its own min/max. That keeps one
// set of helpers usable from both spaces.

/** An axis-aligned rectangle, named by its edges. Matches api_spec.ts:57. */
export interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** A width/height pair. Always non-negative. */
export interface Size {
    width: number;
    height: number;
}

/** A fresh rectangle. */
export function bounds(left = 0, right = 0, top = 0, bottom = 0): Bounds {
    return { left, right, top, bottom };
}

/** Writes the four edges into `out` and returns it. Allocation-free. */
export function boundsSet(
    out: Bounds,
    left: number,
    right: number,
    top: number,
    bottom: number,
): Bounds {
    out.left = left;
    out.right = right;
    out.top = top;
    out.bottom = bottom;
    return out;
}

/** Copies `src` into `out`. Allocation-free. */
export function boundsCopy(out: Bounds, src: Bounds): Bounds {
    out.left = src.left;
    out.right = src.right;
    out.top = src.top;
    out.bottom = src.bottom;
    return out;
}

/** Horizontal extent. Sign-agnostic. */
export function boundsWidth(b: Bounds): number {
    return Math.abs(b.right - b.left);
}

/** Vertical extent. Sign-agnostic, so it holds in y-up and y-down alike. */
export function boundsHeight(b: Bounds): number {
    return Math.abs(b.bottom - b.top);
}

/** `true` when the two rectangles share any area. Touching edges count as overlapping. */
export function boundsOverlap(a: Bounds, b: Bounds): boolean {
    const aMinX = Math.min(a.left, a.right);
    const aMaxX = Math.max(a.left, a.right);
    const bMinX = Math.min(b.left, b.right);
    const bMaxX = Math.max(b.left, b.right);
    if (aMaxX < bMinX || bMaxX < aMinX) return false;

    const aMinY = Math.min(a.top, a.bottom);
    const aMaxY = Math.max(a.top, a.bottom);
    const bMinY = Math.min(b.top, b.bottom);
    const bMaxY = Math.max(b.top, b.bottom);
    return aMaxY >= bMinY && bMaxY >= aMinY;
}

/** `true` when `point` falls inside `b`. Edges are inclusive. */
export function boundsContains(b: Bounds, x: number, y: number): boolean {
    const inX = x >= Math.min(b.left, b.right) && x <= Math.max(b.left, b.right);
    const inY = y >= Math.min(b.top, b.bottom) && y <= Math.max(b.top, b.bottom);
    return inX && inY;
}

/**
 * Grows `b` outward by `margin` on all four sides, writing into `out`.
 *
 * Direction-aware: each edge moves away from the rectangle's interior, so a y-up rect
 * grows `top` up and a y-down rect grows `top` down.
 */
export function boundsExpand(b: Bounds, margin: number, out: Bounds = bounds()): Bounds {
    const xUp = b.right >= b.left ? margin : -margin;
    const yUp = b.top >= b.bottom ? margin : -margin;
    out.left = b.left - xUp;
    out.right = b.right + xUp;
    out.top = b.top + yUp;
    out.bottom = b.bottom - yUp;
    return out;
}

/** A `Size` from a rectangle's extents. */
export function boundsSize(b: Bounds): Size {
    return { width: boundsWidth(b), height: boundsHeight(b) };
}

// Nothing here assumes a y direction, because one set of helpers has to serve both a y-up world
// rect (`top > bottom`) and a y-down screen rect (`bottom > top`).

/**
 * An axis-aligned rectangle, named by its edges.
 *
 * Mutable where `Vec3` is readonly: every helper below writes through one, and `docs/api_spec.ts`
 * declares the creator-facing shape this way.
 */
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

/** `true` when all four edges match. Compares as authored: a flipped rect is not an equal one. */
export function boundsEqual(a: Readonly<Bounds>, b: Readonly<Bounds>): boolean {
    return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
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
 * Grows `b` outward by `margin` on all four sides, writing into `out`. Allocation-free.
 *
 * Direction-aware: each edge moves away from the rectangle's interior, so a y-up rect
 * grows `top` up and a y-down rect grows `top` down.
 */
export function boundsExpand(out: Bounds, b: Bounds, margin: number): Bounds {
    const xUp = b.right >= b.left ? margin : -margin;
    const yUp = b.top >= b.bottom ? margin : -margin;
    out.left = b.left - xUp;
    out.right = b.right + xUp;
    out.top = b.top + yUp;
    out.bottom = b.bottom - yUp;
    return out;
}

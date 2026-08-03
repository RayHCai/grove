// Contract tests for rectangles.
//
// The whole point of this module is that ONE set of helpers serves two y conventions:
// a world rect is y-up (`top > bottom`, e.g. `camera.viewport`) and a screen rect is
// y-down (`bottom > top`, e.g. `stageRect`). Every query below is therefore asserted in
// BOTH orientations, and `boundsExpand` — the one direction-aware helper — is asserted to
// move `top` in opposite directions for the two.

import { describe, it, expect } from 'vitest';
import type { Bounds } from '../src/bounds.js';
import {
    bounds,
    boundsSet,
    boundsCopy,
    boundsWidth,
    boundsHeight,
    boundsOverlap,
    boundsContains,
    boundsExpand,
    boundsSize,
} from '../src/bounds.js';
import * as math from '../src/index.js';

/** A world viewport: y-up, so `top` is the larger number. 320x200 centered on the origin. */
const worldRect = (): Bounds => bounds(-160, 160, 100, -100);

/** A screen stage rect: y-down, so `bottom` is the larger number. 960x540 from the corner. */
const screenRect = (): Bounds => bounds(0, 960, 0, 540);

describe('bounds', () => {
    it('defaults every edge to 0', () => {
        expect(bounds()).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    });

    it('takes edges in the order left, right, top, bottom', () => {
        expect(bounds(1, 2, 3, 4)).toEqual({ left: 1, right: 2, top: 3, bottom: 4 });
    });

    it('allocates a new object per call', () => {
        expect(bounds()).not.toBe(bounds());
    });
});

describe('boundsSet', () => {
    it('returns the object it was handed rather than a copy', () => {
        const out = bounds();
        expect(boundsSet(out, 1, 2, 3, 4)).toBe(out);
    });

    it('writes the four edges in order', () => {
        const out = bounds(9, 9, 9, 9);
        boundsSet(out, -1, 2, -3, 4);
        expect(out).toEqual({ left: -1, right: 2, top: -3, bottom: 4 });
    });
});

describe('boundsCopy', () => {
    it('returns the object it was handed rather than a copy', () => {
        const out = bounds();
        expect(boundsCopy(out, worldRect())).toBe(out);
    });

    it('copies all four edges without aliasing src', () => {
        const src = worldRect();
        const out = bounds();
        boundsCopy(out, src);
        expect(out).toEqual({ left: -160, right: 160, top: 100, bottom: -100 });
        src.top = 999;
        expect(out.top).toBe(100);
    });
});

describe('boundsWidth / boundsHeight', () => {
    it('measures a y-up world rect', () => {
        const b = worldRect();
        expect(boundsWidth(b)).toBe(320);
        expect(boundsHeight(b)).toBe(200);
    });

    it('measures a y-down screen rect', () => {
        const b = screenRect();
        expect(boundsWidth(b)).toBe(960);
        expect(boundsHeight(b)).toBe(540);
    });

    it('is absolute, so flipping either axis does not produce a negative extent', () => {
        expect(boundsHeight(bounds(0, 10, -5, 5))).toBe(10);
        expect(boundsHeight(bounds(0, 10, 5, -5))).toBe(10);
        expect(boundsWidth(bounds(10, -10, 0, 0))).toBe(20);
    });

    it('is 0 for a degenerate edge', () => {
        expect(boundsWidth(bounds(7, 7, 0, 5))).toBe(0);
        expect(boundsHeight(bounds(0, 5, 7, 7))).toBe(0);
    });
});

describe('boundsOverlap', () => {
    it('detects overlap between two y-up world rects', () => {
        expect(boundsOverlap(worldRect(), bounds(100, 300, 50, -50))).toBe(true);
        expect(boundsOverlap(worldRect(), bounds(200, 300, 50, -50))).toBe(false);
    });

    it('detects overlap between two y-down screen rects', () => {
        expect(boundsOverlap(screenRect(), bounds(900, 1200, 500, 700))).toBe(true);
        expect(boundsOverlap(screenRect(), bounds(0, 960, 541, 600))).toBe(false);
    });

    it('separates on y in a y-up rect', () => {
        // Above the viewport's top edge: min y 101 > max y 100.
        expect(boundsOverlap(worldRect(), bounds(0, 10, 200, 101))).toBe(false);
        // Below the bottom edge.
        expect(boundsOverlap(worldRect(), bounds(0, 10, -101, -200))).toBe(false);
        // Straddling the top edge.
        expect(boundsOverlap(worldRect(), bounds(0, 10, 200, 99))).toBe(true);
    });

    it('separates on y in a y-down rect', () => {
        expect(boundsOverlap(screenRect(), bounds(0, 10, -100, -1))).toBe(false);
        expect(boundsOverlap(screenRect(), bounds(0, 10, 541, 600))).toBe(false);
        expect(boundsOverlap(screenRect(), bounds(0, 10, 539, 600))).toBe(true);
    });

    it('counts touching edges as overlapping', () => {
        // Shared vertical edge at x = 160.
        expect(boundsOverlap(worldRect(), bounds(160, 300, 50, -50))).toBe(true);
        // Shared horizontal edge at the world top, y = 100.
        expect(boundsOverlap(worldRect(), bounds(0, 10, 200, 100))).toBe(true);
        // Shared horizontal edge at the screen bottom, y = 540.
        expect(boundsOverlap(screenRect(), bounds(0, 10, 540, 600))).toBe(true);
        // Single shared corner.
        expect(boundsOverlap(worldRect(), bounds(160, 300, 200, 100))).toBe(true);
    });

    it('holds when the two rects disagree about orientation', () => {
        // Same area, opposite y convention: must still overlap itself.
        const flipped = bounds(-160, 160, -100, 100);
        expect(boundsOverlap(worldRect(), flipped)).toBe(true);
        // And must still separate from a rect that is genuinely elsewhere.
        expect(boundsOverlap(flipped, bounds(0, 10, 101, 200))).toBe(false);
    });

    it('is symmetric', () => {
        const a = worldRect();
        const b = bounds(100, 300, 50, -50);
        const far = bounds(500, 600, 50, -50);
        expect(boundsOverlap(a, b)).toBe(boundsOverlap(b, a));
        expect(boundsOverlap(a, far)).toBe(boundsOverlap(far, a));
    });

    it('treats a zero-extent rect on an edge as overlapping', () => {
        expect(boundsOverlap(worldRect(), bounds(0, 0, 100, 100))).toBe(true);
        expect(boundsOverlap(worldRect(), bounds(0, 0, 101, 101))).toBe(false);
    });
});

describe('boundsContains', () => {
    it('tests a point against a y-up world rect', () => {
        const b = worldRect();
        expect(boundsContains(b, 0, 0)).toBe(true);
        expect(boundsContains(b, 0, 99)).toBe(true);
        expect(boundsContains(b, 0, -99)).toBe(true);
        expect(boundsContains(b, 0, 101)).toBe(false);
        expect(boundsContains(b, 0, -101)).toBe(false);
        expect(boundsContains(b, 161, 0)).toBe(false);
    });

    it('tests a point against a y-down screen rect', () => {
        const b = screenRect();
        expect(boundsContains(b, 480, 270)).toBe(true);
        expect(boundsContains(b, 480, 539)).toBe(true);
        expect(boundsContains(b, 480, -1)).toBe(false);
        expect(boundsContains(b, 480, 541)).toBe(false);
        expect(boundsContains(b, 961, 270)).toBe(false);
    });

    it('includes all four edges and the corners', () => {
        const w = worldRect();
        expect(boundsContains(w, -160, 100)).toBe(true);
        expect(boundsContains(w, 160, -100)).toBe(true);
        const s = screenRect();
        expect(boundsContains(s, 0, 0)).toBe(true);
        expect(boundsContains(s, 960, 540)).toBe(true);
    });

    it('gives the same answer for a rect and its vertically flipped twin', () => {
        const upward = worldRect();
        const downward = bounds(-160, 160, -100, 100);
        for (const y of [-101, -100, -50, 0, 50, 100, 101]) {
            expect(boundsContains(downward, 0, y)).toBe(boundsContains(upward, 0, y));
        }
    });
});

describe('boundsExpand', () => {
    it('grows a y-up rect outward: top increases, bottom decreases', () => {
        const out = boundsExpand(worldRect(), 64);
        expect(out).toEqual({ left: -224, right: 224, top: 164, bottom: -164 });
        expect(boundsHeight(out)).toBe(200 + 128);
    });

    it('grows a y-down rect outward: top decreases, bottom increases', () => {
        const out = boundsExpand(screenRect(), 10);
        expect(out).toEqual({ left: -10, right: 970, top: -10, bottom: 550 });
        expect(boundsHeight(out)).toBe(540 + 20);
    });

    it('grows an x-reversed rect outward too', () => {
        // right < left, so left must increase and right must decrease.
        expect(boundsExpand(bounds(160, -160, 100, -100), 40)).toEqual({
            left: 200,
            right: -200,
            top: 140,
            bottom: -140,
        });
    });

    it('always adds 2 x margin to both extents regardless of orientation', () => {
        for (const b of [worldRect(), screenRect(), bounds(160, -160, -100, 100)]) {
            const out = boundsExpand(b, 7);
            expect(boundsWidth(out)).toBe(boundsWidth(b) + 14);
            expect(boundsHeight(out)).toBe(boundsHeight(b) + 14);
        }
    });

    it('shrinks on a negative margin', () => {
        expect(boundsExpand(worldRect(), -10)).toEqual({
            left: -150,
            right: 150,
            top: 90,
            bottom: -90,
        });
        expect(boundsExpand(screenRect(), -10)).toEqual({
            left: 10,
            right: 950,
            top: 10,
            bottom: 530,
        });
    });

    it('is a no-op on a zero margin', () => {
        expect(boundsExpand(worldRect(), 0)).toEqual(worldRect());
    });

    it('returns the out object it was handed and leaves the source untouched', () => {
        const src = worldRect();
        const out = bounds();
        expect(boundsExpand(src, 5, out)).toBe(out);
        expect(src).toEqual(worldRect());
    });

    it('allocates a fresh rect when out is omitted', () => {
        const src = worldRect();
        const out = boundsExpand(src, 5);
        expect(out).not.toBe(src);
        expect(boundsExpand(src, 5)).not.toBe(out);
    });

    it('is safe in place, with out aliased to the source', () => {
        const b = worldRect();
        const out = boundsExpand(b, 64, b);
        expect(out).toBe(b);
        expect(b).toEqual({ left: -224, right: 224, top: 164, bottom: -164 });
    });

    it('treats a degenerate rect as y-up and x-forward', () => {
        // top === bottom and left === right are ties; the `>=` comparisons pick the
        // positive direction, so a point expands into a well-formed y-up square.
        expect(boundsExpand(bounds(0, 0, 0, 0), 3)).toEqual({
            left: -3,
            right: 3,
            top: 3,
            bottom: -3,
        });
    });
});

describe('boundsSize', () => {
    it('reports absolute extents for a y-up rect', () => {
        expect(boundsSize(worldRect())).toEqual({ width: 320, height: 200 });
    });

    it('reports absolute extents for a y-down rect', () => {
        expect(boundsSize(screenRect())).toEqual({ width: 960, height: 540 });
    });

    it('never reports a negative dimension', () => {
        const s = boundsSize(bounds(10, -10, -5, 5));
        expect(s).toEqual({ width: 20, height: 10 });
    });

    it('allocates a fresh Size per call', () => {
        const b = worldRect();
        expect(boundsSize(b)).not.toBe(boundsSize(b));
    });
});

describe('index re-exports', () => {
    it('exposes every rectangle symbol', () => {
        expect(math.bounds).toBe(bounds);
        expect(math.boundsSet).toBe(boundsSet);
        expect(math.boundsCopy).toBe(boundsCopy);
        expect(math.boundsWidth).toBe(boundsWidth);
        expect(math.boundsHeight).toBe(boundsHeight);
        expect(math.boundsOverlap).toBe(boundsOverlap);
        expect(math.boundsContains).toBe(boundsContains);
        expect(math.boundsExpand).toBe(boundsExpand);
        expect(math.boundsSize).toBe(boundsSize);
    });

    it('exposes the Bounds and Size types', () => {
        // Type-only: fails to compile if either name stops being re-exported.
        const b: math.Bounds = worldRect();
        const s: math.Size = boundsSize(b);
        expect(s.width).toBe(320);
    });
});

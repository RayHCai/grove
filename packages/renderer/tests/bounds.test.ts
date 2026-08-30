// The rotated-AABB expansion. Three things go wrong quietly here, so each is asserted with exact
// numbers rather than with a tolerance or a smoke check:
//
//   1. The ANCHOR SIGN. `anchor` is y-down inside the art; local bounds are y-up. Getting that
//      flip backwards mirrors every off-center sprite vertically, which looks like a content
//      bug rather than a math bug.
//   2. QUARTER-TURN FUZZ. `Math.cos(90 * DEG2RAD)` is 6.1e-17, so the naive expansion reports
//      10.000000000000002 for a rect that is exactly 10 wide. Quarter turns are asserted with
//      `toBe`, and the naive form is asserted to be WRONG so the divergence is unambiguous.
//      Diagonals get a tolerance instead: they go through `@platform/math`'s polynomial `sin`
//      and `cos`, which trade about 1e-8 of accuracy for agreeing across engines. Only the 90s
//      bypass the transcendental, which is why only they are exact.
//   3. THE MARGIN'S UNIT. `cullMargin` is WORLD px. If it were ever scaled by zoom, a
//      zoomed-out view would pop sprites at the edge. The zoom-sweep test below is what
//      catches that.

import { describe, expect, it } from 'vitest';
import { DEG2RAD, bounds, boundsHeight, boundsWidth, type Bounds } from '@platform/math';
import {
    DEFAULT_CULL_MARGIN,
    emptyLocalBounds,
    isVisibleInViewport,
    rotatedHalfExtents,
    spriteLocalBounds,
    worldAabb,
} from '../src/bounds.js';

/** The 64x32 texture every anchor case below is measured against. */
const TEX = { width: 64, height: 32 };

/** A y-up 960x540 stage viewport at zoom 1. */
function stageViewport(zoom = 1, cx = 0, cy = 0): Bounds {
    const halfW = 960 / (2 * zoom);
    const halfH = 540 / (2 * zoom);
    return bounds(cx - halfW, cx + halfW, cy + halfH, cy - halfH);
}

describe('DEFAULT_CULL_MARGIN', () => {
    it('is 64 world px — the cull margin unit', () => {
        expect(DEFAULT_CULL_MARGIN).toBe(64);
    });
});

describe('spriteLocalBounds — anchor offset', () => {
    it('centers a 64x32 texture on the origin at the default anchor {0.5, 0.5}', () => {
        expect(spriteLocalBounds(TEX, 1, 1, 0.5, 0.5)).toEqual({
            left: -32,
            right: 32,
            top: 16,
            bottom: -16,
        });
    });

    it('puts the origin at the art TOP-LEFT at anchor {0, 0}, art extending downward', () => {
        // y-up: below the origin is NEGATIVE y. A sign error here would report top: 32.
        expect(spriteLocalBounds(TEX, 1, 1, 0, 0)).toEqual({
            left: 0,
            right: 64,
            top: 0,
            bottom: -32,
        });
    });

    it('puts the origin at the art BOTTOM-RIGHT at anchor {1, 1}', () => {
        expect(spriteLocalBounds(TEX, 1, 1, 1, 1)).toEqual({
            left: -64,
            right: 0,
            top: 32,
            bottom: 0,
        });
    });

    it('handles an off-center anchor {0.25, 0.75}', () => {
        // left = -0.25 * 64 = -16; top = 0.75 * 32 = 24 (three quarters of the art hangs
        // BELOW the origin, because anchor y grows downward).
        expect(spriteLocalBounds(TEX, 1, 1, 0.25, 0.75)).toEqual({
            left: -16,
            right: 48,
            top: 24,
            bottom: -8,
        });
    });

    it('keeps the extent independent of the anchor — only the offset moves', () => {
        for (const [ax, ay] of [
            [0, 0],
            [0.25, 0.75],
            [0.5, 0.5],
            [1, 1],
        ] as const) {
            const b = spriteLocalBounds(TEX, 1, 1, ax, ay);
            expect(boundsWidth(b)).toBe(64);
            expect(boundsHeight(b)).toBe(32);
        }
    });

    it('never emits -0 for an edge that lands on the origin', () => {
        // -anchorX * w is -0 whenever either factor is zero, and Object.is(-0, 0) is false,
        // so a caller comparing edges with Object.is or serializing them would see "-0".
        const topLeft = spriteLocalBounds(TEX, 1, 1, 0, 0);
        expect(Object.is(topLeft.left, 0)).toBe(true);
        expect(Object.is(topLeft.top, 0)).toBe(true);

        const bottomRight = spriteLocalBounds(TEX, 1, 1, 1, 1);
        expect(Object.is(bottomRight.right, 0)).toBe(true);
        expect(Object.is(bottomRight.bottom, 0)).toBe(true);
    });
});

describe('spriteLocalBounds — per-axis scale', () => {
    it('scales each axis independently', () => {
        expect(spriteLocalBounds(TEX, 2, 0.5, 0.5, 0.5)).toEqual({
            left: -64,
            right: 64,
            top: 8,
            bottom: -8,
        });
    });

    it('is unchanged by a horizontal flip when the anchor is centered', () => {
        expect(spriteLocalBounds(TEX, -1, 1, 0.5, 0.5)).toEqual(
            spriteLocalBounds(TEX, 1, 1, 0.5, 0.5),
        );
    });

    it('mirrors an off-center rect about the origin under negative scaleX', () => {
        // scaleX = -1 with a top-left anchor: the art now extends LEFT of the origin. The rect
        // must still come back normalized, left <= right.
        const flipped = spriteLocalBounds(TEX, -1, 1, 0, 0);
        expect(flipped).toEqual({ left: -64, right: 0, top: 0, bottom: -32 });
        expect(flipped.left).toBeLessThanOrEqual(flipped.right);
        expect(boundsWidth(flipped)).toBe(64);
    });

    it('mirrors vertically under negative scaleY, still normalized bottom <= top', () => {
        const flipped = spriteLocalBounds(TEX, 1, -1, 0, 0);
        expect(flipped).toEqual({ left: 0, right: 64, top: 32, bottom: 0 });
        expect(flipped.bottom).toBeLessThanOrEqual(flipped.top);
        expect(boundsHeight(flipped)).toBe(32);
    });

    it('makes a both-axes flip at anchor {1,1} equal the unflipped anchor {0,0}', () => {
        expect(spriteLocalBounds(TEX, -1, -1, 1, 1)).toEqual(spriteLocalBounds(TEX, 1, 1, 0, 0));
    });

    it('normalizes a non-unit negative scale', () => {
        // Unflipped this anchor/scale pair gives {left: -32, right: 96, top: 4, bottom: -12}.
        // Flipping BOTH axes mirrors the rect through the origin, so each edge is the negated
        // opposite edge: left = -right, top = -bottom.
        expect(spriteLocalBounds(TEX, -2, -0.5, 0.25, 0.25)).toEqual({
            left: -96,
            right: 32,
            top: 12,
            bottom: -4,
        });
        expect(spriteLocalBounds(TEX, 2, 0.5, 0.25, 0.25)).toEqual({
            left: -32,
            right: 96,
            top: 4,
            bottom: -12,
        });
    });

    it('collapses to a point at scale 0', () => {
        const b = spriteLocalBounds(TEX, 0, 0, 0.5, 0.5);
        expect(b).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
        expect(Object.is(b.left, 0)).toBe(true);
        expect(Object.is(b.bottom, 0)).toBe(true);
    });
});

describe('spriteLocalBounds — zero-size textures', () => {
    it('returns a zero rect at the origin for a 0x0 texture at any anchor', () => {
        for (const [ax, ay] of [
            [0, 0],
            [0.5, 0.5],
            [1, 1],
        ] as const) {
            const b = spriteLocalBounds({ width: 0, height: 0 }, 1, 1, ax, ay);
            expect(b).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
            // -0 sneaks in here on every anchor except 0, hence the explicit check.
            expect(Object.is(b.left, 0)).toBe(true);
            expect(Object.is(b.top, 0)).toBe(true);
        }
    });

    it('keeps the live axis of a zero-width texture', () => {
        expect(spriteLocalBounds({ width: 0, height: 32 }, 1, 1, 0.5, 0.5)).toEqual({
            left: 0,
            right: 0,
            top: 16,
            bottom: -16,
        });
    });

    it('keeps the live axis of a zero-height texture', () => {
        expect(spriteLocalBounds({ width: 64, height: 0 }, 1, 1, 0.5, 0.5)).toEqual({
            left: -32,
            right: 32,
            top: 0,
            bottom: 0,
        });
    });
});

describe('spriteLocalBounds / emptyLocalBounds — out parameter', () => {
    it('writes into `out` and returns that same object', () => {
        const out = bounds(1, 2, 3, 4);
        expect(spriteLocalBounds(TEX, 1, 1, 0.5, 0.5, out)).toBe(out);
        expect(out).toEqual({ left: -32, right: 32, top: 16, bottom: -16 });
    });

    it('gives a group zero extent at the origin — a group is never culled', () => {
        expect(emptyLocalBounds()).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });

        const out = bounds(1, 2, 3, 4);
        expect(emptyLocalBounds(out)).toBe(out);
        expect(boundsWidth(out)).toBe(0);
        expect(boundsHeight(out)).toBe(0);
    });
});

describe('rotatedHalfExtents — quarter turns are EXACT', () => {
    it('is the identity at 0 degrees', () => {
        expect(rotatedHalfExtents(10, 20, 0)).toEqual({ hx: 10, hy: 20 });
    });

    it('swaps the axes exactly at 90, with no floating-point residue', () => {
        expect(rotatedHalfExtents(10, 20, 90)).toEqual({ hx: 20, hy: 10 });
    });

    it('does NOT agree with the naive Math.sin/Math.cos form at 90', () => {
        // This is the fuzz the exact quarter-turn path exists to remove. 1e-16 of slop is
        // harmless in a cull test but visible in a selection rectangle the editor draws.
        const naiveHy =
            Math.abs(Math.sin(90 * DEG2RAD)) * 10 + Math.abs(Math.cos(90 * DEG2RAD)) * 20;
        expect(naiveHy).not.toBe(10);
        expect(naiveHy).toBeCloseTo(10, 12);
        expect(rotatedHalfExtents(10, 20, 90).hy).toBe(10);
    });

    it('is exact at 180, 270, -90, 360 and a multi-turn 630', () => {
        expect(rotatedHalfExtents(10, 20, 180)).toEqual({ hx: 10, hy: 20 });
        expect(rotatedHalfExtents(10, 20, 270)).toEqual({ hx: 20, hy: 10 });
        expect(rotatedHalfExtents(10, 20, -90)).toEqual({ hx: 20, hy: 10 });
        expect(rotatedHalfExtents(10, 20, -180)).toEqual({ hx: 10, hy: 20 });
        expect(rotatedHalfExtents(10, 20, 360)).toEqual({ hx: 10, hy: 20 });
        expect(rotatedHalfExtents(10, 20, 630)).toEqual({ hx: 20, hy: 10 }); // 630 = 720 - 90
    });
});

describe('rotatedHalfExtents — 45 degrees', () => {
    it("expands a SQUARE's half-extent to hx * sqrt(2)", () => {
        // A 45-degree square is the largest relative expansion possible.
        const r = rotatedHalfExtents(10, 10, 45);
        expect(r.hx).toBeCloseTo(10 * Math.SQRT2, 7);
        expect(r.hy).toBeCloseTo(10 * Math.SQRT2, 7);
    });

    it('makes a non-square rect SQUARE at 45, both half-extents (hx + hy) / sqrt(2)', () => {
        const r = rotatedHalfExtents(10, 20, 45);
        expect(r.hx).toBe(r.hy);
        expect(r.hx).toBeCloseTo(30 * Math.SQRT1_2, 7);
    });

    it('is quadrant-independent at -45, 45, 135, 225 and -315', () => {
        // Taking |cos| and |sin| erases the sign, so every 45-degree diagonal expands the same.
        const at45 = rotatedHalfExtents(10, 20, 45);
        for (const degrees of [-45, 135, 225, -315, 315, -135]) {
            const r = rotatedHalfExtents(10, 20, degrees);
            expect(r.hx).toBeCloseTo(at45.hx, 7);
            expect(r.hy).toBeCloseTo(at45.hy, 7);
        }
    });
});

describe('rotatedHalfExtents — a non-multiple of 45', () => {
    it('matches the closed form at 30 degrees', () => {
        // hx' = cos30*10 + sin30*20 = 5*sqrt(3) + 10
        // hy' = sin30*10 + cos30*20 = 5 + 10*sqrt(3)
        const r = rotatedHalfExtents(10, 20, 30);
        expect(r.hx).toBeCloseTo(5 * Math.sqrt(3) + 10, 7);
        expect(r.hy).toBeCloseTo(5 + 10 * Math.sqrt(3), 7);
    });

    it('mirrors 30 into 60 by swapping the axes', () => {
        const at30 = rotatedHalfExtents(10, 20, 30);
        const at60 = rotatedHalfExtents(20, 10, 60);
        expect(at60.hx).toBeCloseTo(at30.hx, 12);
        expect(at60.hy).toBeCloseTo(at30.hy, 12);
    });
});

describe('rotatedHalfExtents — invariants', () => {
    it('reads negative half-extents as magnitudes', () => {
        expect(rotatedHalfExtents(-10, 20, 0)).toEqual({ hx: 10, hy: 20 });
        expect(rotatedHalfExtents(10, -20, 90)).toEqual({ hx: 20, hy: 10 });
        expect(rotatedHalfExtents(-10, -20, 45)).toEqual(rotatedHalfExtents(10, 20, 45));
    });

    it('never returns a negative half-extent, and never shrinks the perimeter', () => {
        // |cos| + |sin| >= 1 for every angle, so hx' + hy' >= hx + hy. A sign error inside the
        // expansion shows up here as a shrink.
        for (let degrees = -360; degrees <= 360; degrees += 7) {
            const r = rotatedHalfExtents(10, 20, degrees);
            expect(r.hx).toBeGreaterThanOrEqual(0);
            expect(r.hy).toBeGreaterThanOrEqual(0);
            expect(r.hx + r.hy).toBeGreaterThanOrEqual(30 - 1e-12);
        }
    });

    it('leaves a zero-extent rect at zero for every angle', () => {
        for (const degrees of [0, 30, 45, 90, 180, 270, -45]) {
            expect(rotatedHalfExtents(0, 0, degrees)).toEqual({ hx: 0, hy: 0 });
        }
    });
});

describe('worldAabb — translation', () => {
    it('translates an unrotated centered rect', () => {
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        expect(worldAabb(local, 0, 100, 50)).toEqual({
            left: 68,
            right: 132,
            top: 66,
            bottom: 34,
        });
    });

    it('keeps top > bottom — the world rect stays y-up', () => {
        const local = spriteLocalBounds(TEX, 1, 1, 0.25, 0.75);
        for (const degrees of [0, 30, 45, 90, 180, 270, -45]) {
            const b = worldAabb(local, degrees, -12, 7);
            expect(b.top).toBeGreaterThan(b.bottom);
            expect(b.right).toBeGreaterThan(b.left);
        }
    });

    it('writes into `out` and returns that same object', () => {
        const out = bounds(9, 9, 9, 9);
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        expect(worldAabb(local, 0, 0, 0, out)).toBe(out);
        expect(out).toEqual({ left: -32, right: 32, top: 16, bottom: -16 });
    });
});

describe('worldAabb — rotation about the node ORIGIN, not the rect center', () => {
    it('swaps the extents of a centered rect at 90 degrees, exactly', () => {
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        expect(worldAabb(local, 90, 0, 0)).toEqual({
            left: -16,
            right: 16,
            top: 32,
            bottom: -32,
        });
    });

    it('sweeps an off-center rect around the origin at 90 degrees', () => {
        // Anchor {0,0}: the art occupies x in [0, 64], y in [-32, 0]. A CCW quarter turn maps
        // (x, y) -> (-y, x), so x' in [0, 32] and y' in [0, 64]. Rotating about the rect's own
        // center instead would leave the AABB straddling the origin — the bug this catches.
        const local = spriteLocalBounds(TEX, 1, 1, 0, 0);
        expect(worldAabb(local, 90, 0, 0)).toEqual({
            left: 0,
            right: 32,
            top: 64,
            bottom: 0,
        });
    });

    it('reflects an off-center rect through the origin at 180 degrees', () => {
        // (x, y) -> (-x, -y): x' in [-64, 0], y' in [0, 32].
        const local = spriteLocalBounds(TEX, 1, 1, 0, 0);
        expect(worldAabb(local, 180, 0, 0)).toEqual({
            left: -64,
            right: 0,
            top: 32,
            bottom: 0,
        });
    });

    it('sweeps the other way at 270 / -90', () => {
        // (x, y) -> (y, -x): x' in [-32, 0], y' in [-64, 0].
        const local = spriteLocalBounds(TEX, 1, 1, 0, 0);
        const expected = { left: -32, right: 0, top: 0, bottom: -64 };
        expect(worldAabb(local, 270, 0, 0)).toEqual(expected);
        expect(worldAabb(local, -90, 0, 0)).toEqual(expected);
    });

    it('adds the world position after the rotation, never before', () => {
        // Rotating position-then-offset would put this at (0, 0) + rotate(100, 0) = (0, 100).
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        expect(worldAabb(local, 90, 100, 0)).toEqual({
            left: 84,
            right: 116,
            top: 32,
            bottom: -32,
        });
    });

    it('expands a 45-degree square to hx * sqrt(2) about its world position', () => {
        const local = spriteLocalBounds({ width: 20, height: 20 }, 1, 1, 0.5, 0.5);
        const b = worldAabb(local, 45, 10, 20);
        const half = 10 * Math.SQRT2;
        expect(b.left).toBeCloseTo(10 - half, 7);
        expect(b.right).toBeCloseTo(10 + half, 7);
        expect(b.top).toBeCloseTo(20 + half, 7);
        expect(b.bottom).toBeCloseTo(20 - half, 7);
        expect(boundsWidth(b)).toBeCloseTo(20 * Math.SQRT2, 7);
    });

    it('agrees with rotatedHalfExtents for a centered rect at 30 degrees', () => {
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        const r = rotatedHalfExtents(32, 16, 30);
        const b = worldAabb(local, 30, 5, -5);
        expect(b.left).toBeCloseTo(5 - r.hx, 12);
        expect(b.right).toBeCloseTo(5 + r.hx, 12);
        expect(b.top).toBeCloseTo(-5 + r.hy, 12);
        expect(b.bottom).toBeCloseTo(-5 - r.hy, 12);
    });

    it('keeps a group a point at its world position for any rotation', () => {
        const local = emptyLocalBounds();
        for (const degrees of [0, 37, 90, 180, -45]) {
            expect(worldAabb(local, degrees, 12, -7)).toEqual({
                left: 12,
                right: 12,
                top: -7,
                bottom: -7,
            });
        }
    });

    it('is correct when `out` IS the input rect (in-place update)', () => {
        // The cull scan is allocation-free, so it is natural to pass the local rect as `out`.
        // Every read must happen before the first write, or the second axis reads a value the
        // first one already clobbered.
        const inPlace = spriteLocalBounds(TEX, 1, 1, 0, 0);
        expect(worldAabb(inPlace, 90, 10, 20, inPlace)).toBe(inPlace);
        expect(inPlace).toEqual(worldAabb(spriteLocalBounds(TEX, 1, 1, 0, 0), 90, 10, 20));
        expect(inPlace).toEqual({ left: 10, right: 42, top: 84, bottom: 20 });
    });

    it('normalizes an inverted input rect rather than producing a negative extent', () => {
        const inverted = bounds(32, -32, -16, 16); // left > right, top < bottom
        expect(worldAabb(inverted, 0, 0, 0)).toEqual({
            left: -32,
            right: 32,
            top: 16,
            bottom: -16,
        });
    });
});

describe('isVisibleInViewport', () => {
    const viewport = stageViewport(); // { left: -480, right: 480, top: 270, bottom: -270 }

    it('draws a node inside the viewport with no margin', () => {
        const b = worldAabb(spriteLocalBounds(TEX, 1, 1, 0.5, 0.5), 0, 0, 0);
        expect(isVisibleInViewport(b, viewport, 0)).toBe(true);
    });

    it('culls a node far outside on either axis', () => {
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        expect(isVisibleInViewport(worldAabb(local, 0, 5000, 0), viewport, 0)).toBe(false);
        expect(isVisibleInViewport(worldAabb(local, 0, -5000, 0), viewport, 0)).toBe(false);
        expect(isVisibleInViewport(worldAabb(local, 0, 0, 5000), viewport, 0)).toBe(false);
        expect(isVisibleInViewport(worldAabb(local, 0, 0, -5000), viewport, 0)).toBe(false);
        expect(
            isVisibleInViewport(worldAabb(local, 0, 5000, 5000), viewport, DEFAULT_CULL_MARGIN),
        ).toBe(false);
    });

    it('counts an exactly-touching edge as visible', () => {
        // left === viewport.right: one pixel column of the sprite is on screen.
        const touching = bounds(480, 520, 16, -16);
        expect(isVisibleInViewport(touching, viewport, 0)).toBe(true);

        const touchingTop = bounds(-16, 16, 300, 270);
        expect(isVisibleInViewport(touchingTop, viewport, 0)).toBe(true);
    });

    it('pulls a just-outside node back in with the 64 px margin', () => {
        // 20 world px of gap: culled bare, drawn with slack.
        const justOutside = bounds(500, 540, 16, -16);
        expect(isVisibleInViewport(justOutside, viewport, 0)).toBe(false);
        expect(isVisibleInViewport(justOutside, viewport, DEFAULT_CULL_MARGIN)).toBe(true);
    });

    it('is exact at the margin boundary', () => {
        // 480 + 64 = 544 touches the expanded edge; anything beyond it does not.
        expect(isVisibleInViewport(bounds(544, 600, 16, -16), viewport, 64)).toBe(true);
        expect(isVisibleInViewport(bounds(544.0001, 600, 16, -16), viewport, 64)).toBe(false);
    });

    it('grows the margin UPWARD from a y-up viewport top edge', () => {
        // The y-up trap: `boundsExpand` must move `top` to 334, not to 206. Getting it
        // backwards would cull everything above the camera and over-draw below it.
        expect(isVisibleInViewport(bounds(-16, 16, 400, 334), viewport, 64)).toBe(true);
        expect(isVisibleInViewport(bounds(-16, 16, 400, 334.0001), viewport, 64)).toBe(false);
        expect(isVisibleInViewport(bounds(-16, 16, -334, -400), viewport, 64)).toBe(true);
        expect(isVisibleInViewport(bounds(-16, 16, -334.0001, -400), viewport, 64)).toBe(false);
    });

    it('treats a non-finite margin as zero rather than culling the whole scene', () => {
        const touching = bounds(480, 520, 16, -16);
        expect(isVisibleInViewport(touching, viewport, Number.NaN)).toBe(true);
        expect(isVisibleInViewport(bounds(500, 540, 16, -16), viewport, Number.NaN)).toBe(false);
        expect(isVisibleInViewport(touching, viewport, Number.POSITIVE_INFINITY)).toBe(true);
        expect(
            isVisibleInViewport(bounds(500, 540, 16, -16), viewport, Number.POSITIVE_INFINITY),
        ).toBe(false);
    });

    it('clamps a NEGATIVE margin to zero instead of insetting the viewport', () => {
        // `cullMargin` is slack ADDED to the viewport; an inset has no specified meaning.
        // Honouring one is unsafe: `boundsExpand` moves each edge toward the interior, so an
        // inset deeper than the viewport half-extent INVERTS the axis, and `boundsOverlap`
        // re-normalizes min/max — so the inverted rect reads as a valid one that GROWS as the
        // inset deepens. That makes the test non-monotonic: a deeper inset draws MORE.
        const inside = bounds(-100, 100, 16, -16);
        const justOutside = bounds(500, 540, 16, -16);
        for (const margin of [-1, -64, -269, -271, -540, -1100, -5000]) {
            // A node inside the viewport is never culled by an inset...
            expect(isVisibleInViewport(inside, viewport, margin)).toBe(true);
            // ...and one outside it is never revealed by one.
            expect(isVisibleInViewport(justOutside, viewport, margin)).toBe(false);
        }
    });

    it('never re-admits a far-off node as the margin decreases (monotonic in the margin)', () => {
        // The concrete regression: a 200x100 viewport with margin -1100 used to report a node
        // 1000 world px off screen on BOTH axes as visible.
        const tight = bounds(-100, 100, 50, -50);
        const farAway = bounds(1000, 1064, 1000, 968);
        for (const margin of [64, 0, -50, -100, -150, -600, -1100, -2000]) {
            expect(isVisibleInViewport(farAway, tight, margin)).toBe(false);
        }
    });

    it('mutates neither argument, and does not accumulate margin across calls', () => {
        // The expanded viewport is module-level scratch; a missed reset would make the
        // effective margin grow every frame and eventually stop culling anything.
        const before = { ...viewport };
        const farOut = bounds(600, 640, 16, -16);
        for (let i = 0; i < 10; i++) {
            expect(isVisibleInViewport(farOut, viewport, 64)).toBe(false);
        }
        expect(viewport).toEqual(before);
        expect(farOut).toEqual({ left: 600, right: 640, top: 16, bottom: -16 });
    });
});

describe('isVisibleInViewport — cullMargin is WORLD px, never CSS px', () => {
    it('yields the same world slack at every zoom, because the function never sees a zoom', () => {
        // The viewport shrinks in world units as zoom rises, but 64 always means 64
        // WORLD px of slack. A sprite 63 world px past the right edge is drawn at every zoom
        // and one 65 past it is culled at every zoom. If the margin were CSS px, the same 64
        // would buy 6.4 world px at zoom 10 and 640 at zoom 0.1 — the zoomed-out editor view
        // would pop sprites and the zoomed-in game view would over-draw.
        for (const zoom of [0.1, 0.5, 1, 2, 10]) {
            const viewport = stageViewport(zoom);
            const inside = bounds(viewport.right + 63, viewport.right + 70, 0, 0);
            const outside = bounds(viewport.right + 65, viewport.right + 70, 0, 0);
            expect(isVisibleInViewport(inside, viewport, 64)).toBe(true);
            expect(isVisibleInViewport(outside, viewport, 64)).toBe(false);
        }
    });

    it('gives an off-center camera the same slack as a centered one', () => {
        const centered = stageViewport(1, 0, 0);
        const panned = stageViewport(1, 1000, -700);
        const nearCentered = bounds(centered.right + 32, centered.right + 40, 0, 0);
        const nearPanned = bounds(panned.right + 32, panned.right + 40, -700, -700);
        expect(isVisibleInViewport(nearCentered, centered, 64)).toBe(true);
        expect(isVisibleInViewport(nearPanned, panned, 64)).toBe(true);
        expect(isVisibleInViewport(nearPanned, centered, 64)).toBe(false);
    });

    it('makes a rotated sprite near the edge visible only because of the expansion', () => {
        // A 64x32 sprite at 45 degrees has a half-width of 48*SQRT1_2 = 33.94, up from 32.
        // Placed so the unrotated rect misses the edge by 33, only the rotated AABB reaches it.
        const local = spriteLocalBounds(TEX, 1, 1, 0.5, 0.5);
        const viewport = stageViewport();
        const x = viewport.right + 33;
        expect(isVisibleInViewport(worldAabb(local, 0, x, 0), viewport, 0)).toBe(false);
        expect(isVisibleInViewport(worldAabb(local, 45, x, 0), viewport, 0)).toBe(true);
    });
});

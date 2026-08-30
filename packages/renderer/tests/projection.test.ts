// World <-> screen, the y-flip, degrees -> radians, and UI anchors.
//
// The y-flip round-trip is the highest-risk case here. The sign is asserted
// directly — a point ABOVE the camera in world space must get a SMALLER screen y — and then
// the inverse is checked over a fixed TABLE of cameras, zooms, modes, framings and non-square
// canvases. The table is fixed on purpose: Math.random() would make a failure unreproducible,
// and a sign error is not a rare event needing a search to find.
//
// The design stage is 800x600, so the wide canvas 1600x900 gives fitScale exactly 1.5 under
// 'fit' and exactly 2 under 'fill'. Every expected value below is exact in binary floating
// point, which is why these are `toBe`/`toEqual` rather than `toBeCloseTo`.

import { describe, it, expect } from 'vitest';
import { DEG2RAD } from '@platform/math';
import type { Bounds, Size } from '@platform/math';
import type { CameraState, Framing, ScaleMode, UiAnchor } from '../src/renderer.js';
import {
    cameraScale,
    flipY,
    pixiRotation,
    screenToWorld,
    uiAnchorOrigin,
    uiToScreen,
    worldToScreen,
} from '../src/projection.js';
import { stageRect } from '../src/viewport.js';

const DESIGN = { width: 800, height: 600 };
/** fitScale 1.5 under 'fit', 2 under 'fill'. Canvas center is (800, 450). */
const WIDE = { width: 1600, height: 900 };

function camera(x: number, y: number, zoom: number, framing?: Framing): CameraState {
    return framing === undefined
        ? { position: { x, y }, zoom }
        : { position: { x, y }, zoom, framing };
}

describe('cameraScale', () => {
    it('is fitScale * zoom', () => {
        expect(cameraScale(camera(0, 0, 1), 'fit', WIDE, DESIGN)).toBe(1.5);
        expect(cameraScale(camera(0, 0, 2), 'fit', WIDE, DESIGN)).toBe(3);
        expect(cameraScale(camera(0, 0, 0.5), 'fit', WIDE, DESIGN)).toBe(0.75);
        expect(cameraScale(camera(0, 0, 2), 'fill', WIDE, DESIGN)).toBe(4);
        expect(cameraScale(camera(0, 0, 2), 'expand', WIDE, DESIGN)).toBe(2);
    });

    it("ignores the scale mode under 'free' framing — zoom is literal px per world unit", () => {
        for (const mode of ['fit', 'fill', 'expand'] as const) {
            expect(cameraScale(camera(0, 0, 3, 'free'), mode, WIDE, DESIGN)).toBe(3);
        }
    });

    it('falls back to a positive scale for a degenerate zoom, so nothing divides by zero', () => {
        for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const s = cameraScale(camera(0, 0, zoom), 'fit', WIDE, DESIGN);
            expect(s).toBe(1.5);
            expect(Number.isFinite(s)).toBe(true);
        }
    });
});

describe('pixiRotation', () => {
    it('negates the authored angle — CCW-positive world, CW-positive backend', () => {
        expect(pixiRotation(90)).toBe(-Math.PI / 2);
        expect(pixiRotation(-90)).toBe(Math.PI / 2);
        expect(pixiRotation(180)).toBe(-Math.PI);
        expect(pixiRotation(-180)).toBe(Math.PI);
        expect(pixiRotation(45)).toBe(-Math.PI / 4);
        expect(pixiRotation(270)).toBe((-3 * Math.PI) / 2);
        expect(pixiRotation(360)).toBe(-2 * Math.PI);
    });

    it('is exactly -degrees * DEG2RAD', () => {
        for (const deg of [1, 13.5, 89, 137, -22.25, 1000]) {
            expect(pixiRotation(deg)).toBe(-deg * DEG2RAD);
        }
    });

    it('yields -0 at 0, which is === 0 and harmless at the backend boundary', () => {
        // IEEE 754 negation of zero is -0. `toBe` uses Object.is, so this is asserted as -0
        // deliberately rather than smoothed over in the source: a `+ 0` there would be noise,
        // and no consumer can tell the difference (-0 === 0, and both set the same rotation).
        expect(pixiRotation(0)).toBe(-0);
        expect(pixiRotation(0) === 0).toBe(true);
    });

    it('is its own inverse under negation', () => {
        for (const deg of [0, 30, 90, 123.456, -77]) {
            expect(pixiRotation(-deg)).toBe(-pixiRotation(deg));
        }
    });
});

describe('flipY', () => {
    it('negates, and only negates — the write-boundary flip', () => {
        expect(flipY(100)).toBe(-100);
        expect(flipY(-100)).toBe(100);
        expect(flipY(0.5)).toBe(-0.5);
        // -0 for the same IEEE 754 reason as `pixiRotation(0)`, and equally harmless.
        expect(flipY(0)).toBe(-0);
        expect(flipY(0) === 0).toBe(true);
    });

    it('round-trips exactly', () => {
        for (const y of [0, 1, -1, 123.456, -987654.321, 1e12]) {
            expect(flipY(flipY(y))).toBe(y);
        }
    });
});

describe('worldToScreen', () => {
    it('puts the world origin at the canvas center for a camera at the origin', () => {
        expect(worldToScreen({ x: 0, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN)).toEqual({
            x: 800,
            y: 450,
            z: 0,
        });
    });

    it('gives a point ABOVE the camera a SMALLER screen y — the y-flip', () => {
        const above = worldToScreen({ x: 0, y: 100 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        const below = worldToScreen({ x: 0, y: -100 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        expect(above.y).toBe(300); // 450 - 100 * 1.5
        expect(below.y).toBe(600); // 450 + 100 * 1.5
        expect(above.y).toBeLessThan(450);
        expect(below.y).toBeGreaterThan(450);
        expect(above.y).toBeLessThan(below.y);
    });

    it('does NOT flip x — a point right of the camera has a larger screen x', () => {
        const right = worldToScreen({ x: 100, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        const left = worldToScreen({ x: -100, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        expect(right.x).toBe(950);
        expect(left.x).toBe(650);
    });

    it('puts the camera position itself at the canvas center, wherever it is', () => {
        for (const [cx, cy] of [
            [0, 0],
            [120, -80],
            [-1000.5, 2000.25],
        ] as const) {
            expect(worldToScreen({ x: cx, y: cy }, camera(cx, cy, 2), 'fit', WIDE, DESIGN)).toEqual(
                {
                    x: 800,
                    y: 450,
                    z: 0,
                },
            );
        }
    });

    it('scales the offset by fitScale * zoom', () => {
        // fill: fitScale 2, zoom 1 -> 100 world px is 200 screen px.
        expect(worldToScreen({ x: 0, y: 100 }, camera(0, 0, 1), 'fill', WIDE, DESIGN).y).toBe(250);
        // expand: fitScale 1 -> 100 world px is 100 screen px.
        expect(worldToScreen({ x: 0, y: 100 }, camera(0, 0, 1), 'expand', WIDE, DESIGN).y).toBe(
            350,
        );
        // fit, zoom 2: fitScale 1.5 * 2 = 3 -> 100 world px is 300 screen px.
        expect(worldToScreen({ x: 0, y: 100 }, camera(0, 0, 2), 'fit', WIDE, DESIGN).y).toBe(150);
    });

    it('passes z through unchanged and defaults an omitted z to 0', () => {
        expect(worldToScreen({ x: 0, y: 0, z: 7.5 }, camera(0, 0, 1), 'fit', WIDE, DESIGN).z) //
            .toBe(7.5);
        expect(worldToScreen({ x: 0, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN).z).toBe(0);
        expect(worldToScreen({ x: 0, y: 0, z: -3 }, camera(0, 0, 1), 'fit', WIDE, DESIGN).z) //
            .toBe(-3);
    });

    it('writes into `out` and returns it', () => {
        const out = { x: -1, y: -1, z: -1 };
        const returned = worldToScreen({ x: 0, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN, out);
        expect(returned).toBe(out);
        expect(out).toEqual({ x: 800, y: 450, z: 0 });
    });
});

describe('screenToWorld', () => {
    it('maps the canvas center to the camera position', () => {
        expect(screenToWorld({ x: 800, y: 450 }, camera(120, -80, 2), 'fit', WIDE, DESIGN)).toEqual(
            {
                x: 120,
                y: -80,
                z: 0,
            },
        );
    });

    it('gives a SMALLER screen y a LARGER world y — the flip, read backwards', () => {
        const up = screenToWorld({ x: 800, y: 300 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        const down = screenToWorld({ x: 800, y: 600 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        expect(up.y).toBe(100); // (450 - 300) / 1.5
        expect(down.y).toBe(-100);
        expect(up.y).toBeGreaterThan(down.y);
    });

    it('maps the canvas corners to the expected world corners under fit', () => {
        // fitScale 1.5: the 1600x900 canvas is 1066.67 x 600 world px.
        const topLeft = screenToWorld({ x: 0, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN);
        expect(topLeft.x).toBeCloseTo(-1600 / 3, 12);
        expect(topLeft.y).toBe(300); // top of the screen is POSITIVE world y
        const bottomRight = screenToWorld(
            { x: 1600, y: 900 },
            camera(0, 0, 1),
            'fit',
            WIDE,
            DESIGN,
        );
        expect(bottomRight.x).toBeCloseTo(1600 / 3, 12);
        expect(bottomRight.y).toBe(-300);
    });

    it('passes z through unchanged', () => {
        expect(screenToWorld({ x: 0, y: 0, z: 4 }, camera(0, 0, 1), 'fit', WIDE, DESIGN).z).toBe(4);
        expect(screenToWorld({ x: 0, y: 0 }, camera(0, 0, 1), 'fit', WIDE, DESIGN).z).toBe(0);
    });

    it('writes into `out` and returns it', () => {
        const out = { x: -1, y: -1, z: -1 };
        const returned = screenToWorld(
            { x: 800, y: 450 },
            camera(0, 0, 1),
            'fit',
            WIDE,
            DESIGN,
            out,
        );
        expect(returned).toBe(out);
        expect(out).toEqual({ x: 0, y: 0, z: 0 });
    });
});

describe('the y-flip round-trip', () => {
    // A fixed table, not Math.random(): a failure has to be reproducible, and a sign error
    // shows up on the first row anyway. The cameras include negative and fractional
    // positions, the zooms span 0.25..3, and the canvases are deliberately non-square and
    // odd-sized so no exact-power-of-two coincidence can hide a bug.
    const CAMERAS: readonly CameraState[] = [
        camera(0, 0, 1),
        camera(120, -80, 1),
        camera(-333.25, 417.75, 2),
        camera(10_000, -10_000, 0.25),
        camera(7.5, 7.5, 3),
        camera(-1.5, 0.5, 1, 'free'),
        camera(640, 360, 2, 'free'),
    ];
    const CANVASES: readonly Size[] = [
        { width: 1600, height: 900 },
        { width: 800, height: 1800 },
        { width: 1023, height: 769 },
        { width: 100, height: 100 },
    ];
    const MODES: readonly ScaleMode[] = ['fit', 'fill', 'expand'];
    const POINTS = [
        { x: 0, y: 0 },
        { x: 123.5, y: -456.25 },
        { x: -999, y: 1000 },
        { x: 100_000, y: -100_000 },
        { x: 0.0001, y: -0.0001 },
    ] as const;

    it('screenToWorld(worldToScreen(p)) === p to within 1e-9 across the whole table', () => {
        for (const cam of CAMERAS) {
            for (const canvas of CANVASES) {
                for (const mode of MODES) {
                    for (const point of POINTS) {
                        const screen = worldToScreen({ ...point, z: 5 }, cam, mode, canvas, DESIGN);
                        const back = screenToWorld(screen, cam, mode, canvas, DESIGN);
                        expect(Math.abs(back.x - point.x)).toBeLessThan(1e-9);
                        expect(Math.abs(back.y - point.y)).toBeLessThan(1e-9);
                        expect(back.z).toBe(5);
                    }
                }
            }
        }
    });

    it('worldToScreen(screenToWorld(s)) === s to within 1e-9 across the whole table', () => {
        const SCREEN_POINTS = [
            { x: 0, y: 0 },
            { x: 800, y: 450 },
            { x: 37.5, y: 902.25 },
            { x: -50, y: -50 },
        ] as const;
        for (const cam of CAMERAS) {
            for (const canvas of CANVASES) {
                for (const mode of MODES) {
                    for (const point of SCREEN_POINTS) {
                        const world = screenToWorld(point, cam, mode, canvas, DESIGN);
                        const back = worldToScreen(world, cam, mode, canvas, DESIGN);
                        expect(Math.abs(back.x - point.x)).toBeLessThan(1e-9);
                        expect(Math.abs(back.y - point.y)).toBeLessThan(1e-9);
                    }
                }
            }
        }
    });

    it('round-trips exactly for a degenerate canvas or zoom rather than producing NaN', () => {
        const degenerate: readonly Size[] = [
            { width: 0, height: 0 },
            { width: Number.NaN, height: 900 },
        ];
        for (const canvas of degenerate) {
            for (const zoom of [1, 0, Number.NaN]) {
                const screen = worldToScreen(
                    { x: 12, y: -34 },
                    camera(0, 0, zoom),
                    'fit',
                    canvas,
                    DESIGN,
                );
                expect(Number.isFinite(screen.x)).toBe(true);
                expect(Number.isFinite(screen.y)).toBe(true);
                const back = screenToWorld(screen, camera(0, 0, zoom), 'fit', canvas, DESIGN);
                expect(back.x).toBeCloseTo(12, 9);
                expect(back.y).toBeCloseTo(-34, 9);
            }
        }
    });
});

describe('uiAnchorOrigin', () => {
    // A stage rect offset from the canvas origin on BOTH axes, which is what makes the anchor
    // logic testable: an origin-anchored rect would let a left/top mix-up pass. This is the
    // real 'expand' stage rect for the 800x600 design on the 1600x900 canvas.
    const STAGE: Bounds = stageRect('stage', 'expand', WIDE, DESIGN);

    it('is the offset rect this test intends — sanity, so the table below means something', () => {
        expect(STAGE).toEqual({ left: 400, right: 1200, top: 150, bottom: 750 });
        expect(STAGE.bottom).toBeGreaterThan(STAGE.top); // screen space, y-down
    });

    it('places all nine anchors exactly', () => {
        const expected: Record<UiAnchor, { x: number; y: number }> = {
            'top-left': { x: 400, y: 150 },
            'top-center': { x: 800, y: 150 },
            'top-right': { x: 1200, y: 150 },
            'middle-left': { x: 400, y: 450 },
            center: { x: 800, y: 450 },
            'middle-right': { x: 1200, y: 450 },
            'bottom-left': { x: 400, y: 750 },
            'bottom-center': { x: 800, y: 750 },
            'bottom-right': { x: 1200, y: 750 },
        };
        for (const [anchor, point] of Object.entries(expected) as [
            UiAnchor,
            { x: number; y: number },
        ][]) {
            expect(uiAnchorOrigin(anchor, STAGE)).toEqual({ ...point, z: 0 });
        }
    });

    it("gives 'top-*' the SMALLER y, because screen space is y-DOWN", () => {
        expect(uiAnchorOrigin('top-left', STAGE).y).toBeLessThan(
            uiAnchorOrigin('bottom-left', STAGE).y,
        );
        expect(uiAnchorOrigin('top-center', STAGE).y).toBeLessThan(
            uiAnchorOrigin('center', STAGE).y,
        );
        expect(uiAnchorOrigin('center', STAGE).y).toBeLessThan(
            uiAnchorOrigin('bottom-center', STAGE).y,
        );
    });

    it('lands exactly ON the edges, not a rounding error away', () => {
        // A stage whose midpoint is not exactly representable, to catch a lerp that
        // overshoots at fraction 1.
        const odd: Bounds = { left: 0.1, right: 0.30000000000000004, top: 1 / 3, bottom: 2 / 3 };
        expect(uiAnchorOrigin('top-left', odd).x).toBe(odd.left);
        expect(uiAnchorOrigin('top-left', odd).y).toBe(odd.top);
        expect(uiAnchorOrigin('bottom-right', odd).x).toBe(odd.right);
        expect(uiAnchorOrigin('bottom-right', odd).y).toBe(odd.bottom);
        expect(uiAnchorOrigin('top-right', odd).x).toBe(odd.right);
        expect(uiAnchorOrigin('bottom-left', odd).y).toBe(odd.bottom);
    });

    it('lands on the edges for a rect where the naive lerp actually MISSES them', () => {
        // The `odd` rect above does not exercise `edge()`'s exact-endpoint guard: for those
        // values `lo + (hi - lo) * 1 === hi` already, so removing the guard keeps the test
        // green. Catastrophic cancellation is what makes the guard load-bearing, so pick a
        // rect whose edges differ by many orders of magnitude.
        const wild: Bounds = { left: 1e16, right: 3, top: -1e16, bottom: 7 };

        // Confirm the naive form really is wrong here, so this test can fail.
        expect(wild.left + (wild.right - wild.left) * 1).not.toBe(wild.right);
        expect(wild.top + (wild.bottom - wild.top) * 1).not.toBe(wild.bottom);

        expect(uiAnchorOrigin('bottom-right', wild).x).toBe(wild.right);
        expect(uiAnchorOrigin('bottom-right', wild).y).toBe(wild.bottom);
        expect(uiAnchorOrigin('top-left', wild).x).toBe(wild.left);
        expect(uiAnchorOrigin('top-left', wild).y).toBe(wild.top);
    });

    it('works on the real letterboxed stage rect too', () => {
        const letterboxed = stageRect('stage', 'fit', WIDE, DESIGN);
        expect(letterboxed).toEqual({ left: 200, right: 1400, top: 0, bottom: 900 });
        expect(uiAnchorOrigin('top-left', letterboxed)).toEqual({ x: 200, y: 0, z: 0 });
        expect(uiAnchorOrigin('center', letterboxed)).toEqual({ x: 800, y: 450, z: 0 });
        expect(uiAnchorOrigin('bottom-right', letterboxed)).toEqual({ x: 1400, y: 900, z: 0 });
    });

    it('writes into `out` and returns it', () => {
        const out = { x: -1, y: -1, z: -1 };
        const returned = uiAnchorOrigin('center', STAGE, out);
        expect(returned).toBe(out);
        expect(out).toEqual({ x: 800, y: 450, z: 0 });
    });
});

describe('uiToScreen', () => {
    // The letterboxed stage for the 800x600 design on the 1600x900 canvas: fitScale 1.5, so
    // a design-px offset is NOT a CSS-px offset, which is the whole point of a UI anchor.
    const STAGE: Bounds = stageRect('stage', 'fit', WIDE, DESIGN);
    const FIT = 1.5;

    it("{uiAnchor: 'top-left', position: {x: 20, y: 20}} is in and DOWN", () => {
        const p = uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, FIT);
        // 20 design px * 1.5 = 30 CSS px, added on BOTH axes.
        expect(p).toEqual({ x: 230, y: 30, z: 0 });
        expect(p.x).toBeGreaterThan(STAGE.left); // in from the left
        expect(p.y).toBeGreaterThan(STAGE.top); // DOWN from the top
    });

    it('a positive y offset always moves DOWN the screen, from every anchor', () => {
        const anchors: readonly UiAnchor[] = [
            'top-left',
            'top-center',
            'top-right',
            'middle-left',
            'center',
            'middle-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ];
        for (const anchor of anchors) {
            const origin = uiAnchorOrigin(anchor, STAGE);
            const moved = uiToScreen({ x: 0, y: 20 }, anchor, STAGE, FIT);
            expect(moved.y).toBe(origin.y + 30);
            expect(moved.y).toBeGreaterThan(origin.y);
        }
    });

    it('insets from bottom-right with negative offsets', () => {
        expect(uiToScreen({ x: -20, y: -20 }, 'bottom-right', STAGE, FIT)) //
            .toEqual({ x: 1370, y: 870, z: 0 });
    });

    it('offsets from center in all four directions', () => {
        expect(uiToScreen({ x: 10, y: 10 }, 'center', STAGE, FIT)).toEqual({
            x: 815,
            y: 465,
            z: 0,
        });
        expect(uiToScreen({ x: -10, y: -10 }, 'center', STAGE, FIT)).toEqual({
            x: 785,
            y: 435,
            z: 0,
        });
    });

    it('scales the design offset by fitScale — a HUD lands proportionally on every screen', () => {
        expect(uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, 1).y).toBe(20);
        expect(uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, 2).y).toBe(40);
        expect(uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, 0.5).y).toBe(10);
        // The anchor origin itself is NOT scaled — it is already CSS px.
        expect(uiToScreen({ x: 0, y: 0 }, 'top-left', STAGE, 3)).toEqual({ x: 200, y: 0, z: 0 });
    });

    it('is exactly the anchor origin for a zero offset, at any fitScale', () => {
        for (const s of [1, 1.5, 2, 0.25]) {
            expect(uiToScreen({ x: 0, y: 0 }, 'bottom-right', STAGE, s)) //
                .toEqual({ x: 1400, y: 900, z: 0 });
        }
    });

    it('passes z through unchanged and defaults an omitted z to 0', () => {
        expect(uiToScreen({ x: 0, y: 0, z: 9 }, 'center', STAGE, FIT).z).toBe(9);
        expect(uiToScreen({ x: 0, y: 0 }, 'center', STAGE, FIT).z).toBe(0);
    });

    it('treats a degenerate fitScale as 1 rather than collapsing the HUD', () => {
        for (const s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, s)) //
                .toEqual({ x: 220, y: 20, z: 0 });
        }
    });

    it('writes into `out` and returns it', () => {
        const out = { x: -1, y: -1, z: -1 };
        const returned = uiToScreen({ x: 20, y: 20 }, 'top-left', STAGE, FIT, out);
        expect(returned).toBe(out);
        expect(out).toEqual({ x: 230, y: 30, z: 0 });
    });

    it('is correct when `out` IS `offset` — the pooled-scratch call', () => {
        // Callers may reuse pooled objects to hit zero allocation, and the
        // natural in-place form is `uiToScreen(p, anchor, stage, s, p)`. Writing the anchor
        // origin into `out` before reading `offset` would clobber the offset first: for
        // {20,20} at fitScale 1.5 the origin (200,0) lands in `p`, and the result becomes
        // (200 + 200*1.5, 0 + 0*1.5) = (500, 0) instead of (230, 30).
        for (const anchor of ['top-left', 'center', 'bottom-right'] as const) {
            for (const offset of [
                { x: 20, y: 20, z: 0 },
                { x: -15, y: 40, z: 7 },
                { x: 0, y: 0, z: 0 },
            ]) {
                const expected = uiToScreen(offset, anchor, STAGE, FIT);
                const aliased = { ...offset };
                expect(uiToScreen(aliased, anchor, STAGE, FIT, aliased)).toEqual(expected);
            }
        }

        const p = { x: 20, y: 20, z: 0 };
        expect(uiToScreen(p, 'top-left', STAGE, FIT, p)).toEqual({ x: 230, y: 30, z: 0 });
    });
});

// `worldToScreen` / `screenToWorld` are already alias-safe (they read `point` into locals
// before writing `out`); this pins that down so a future refactor cannot regress it.
describe('out-parameter aliasing is safe across the whole module', () => {
    it('worldToScreen and screenToWorld accept out === point', () => {
        for (const mode of ['fit', 'fill', 'expand'] as const) {
            const cam = camera(120, -80, 2);

            const w = { x: 123.5, y: -456.25, z: 3 };
            const wExpected = worldToScreen(w, cam, mode, WIDE, DESIGN);
            const wAliased = { ...w };
            expect(worldToScreen(wAliased, cam, mode, WIDE, DESIGN, wAliased)).toEqual(wExpected);

            const s = { x: 640, y: 360, z: 3 };
            const sExpected = screenToWorld(s, cam, mode, WIDE, DESIGN);
            const sAliased = { ...s };
            expect(screenToWorld(sAliased, cam, mode, WIDE, DESIGN, sAliased)).toEqual(sExpected);
        }
    });
});

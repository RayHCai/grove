// Framing, scale mode, the two rectangles, and the world viewport (§4.1, §4.2).
//
// Every assertion here is an exact number. The design stage is 800x600 throughout, and the
// two canvases are chosen so the ratios stay exactly representable: 1600x900 is WIDER than
// the design aspect (sx=2, sy=1.5) and 800x1800 is TALLER (sx=1, sy=3). That makes "which
// axis governs" visible in the numbers rather than hidden behind rounding.

import { describe, it, expect } from 'vitest';
import { boundsHeight, boundsWidth } from '@platform/math';
import type { CameraState, Framing, ScaleMode } from '../src/renderer.js';
import {
    effectiveResolution,
    fitScale,
    isLetterboxed,
    stageRect,
    visibleRect,
    worldViewport,
} from '../src/viewport.js';

const DESIGN = { width: 800, height: 600 };
/** sx = 2, sy = 1.5 — the height governs under `fit`, the width under `fill`. */
const WIDE = { width: 1600, height: 900 };
/** sx = 1, sy = 3 — the width governs under `fit`, the height under `fill`. */
const TALL = { width: 800, height: 1800 };

const MODES: readonly ScaleMode[] = ['fit', 'fill', 'expand'];
const FRAMINGS: readonly Framing[] = ['stage', 'free'];

function camera(x: number, y: number, zoom: number, framing?: Framing): CameraState {
    return framing === undefined
        ? { position: { x, y }, zoom }
        : { position: { x, y }, zoom, framing };
}

describe('fitScale', () => {
    it('picks the smaller ratio under fit and the larger under fill, on a wide canvas', () => {
        expect(fitScale('stage', 'fit', WIDE, DESIGN)).toBe(1.5);
        expect(fitScale('stage', 'fill', WIDE, DESIGN)).toBe(2);
        expect(fitScale('stage', 'expand', WIDE, DESIGN)).toBe(1);
    });

    it('picks the smaller ratio under fit and the larger under fill, on a tall canvas', () => {
        expect(fitScale('stage', 'fit', TALL, DESIGN)).toBe(1);
        expect(fitScale('stage', 'fill', TALL, DESIGN)).toBe(3);
        expect(fitScale('stage', 'expand', TALL, DESIGN)).toBe(1);
    });

    it("is 1 under 'free' framing for every scale mode — zoom is then literal px/unit", () => {
        for (const mode of MODES) {
            expect(fitScale('free', mode, WIDE, DESIGN)).toBe(1);
            expect(fitScale('free', mode, TALL, DESIGN)).toBe(1);
        }
    });

    it('is 1 when the canvas or the design size is degenerate, never NaN or Infinity', () => {
        const degenerate = [
            { width: 0, height: 900 },
            { width: 1600, height: 0 },
            { width: -1600, height: 900 },
            { width: Number.NaN, height: 900 },
            { width: Number.POSITIVE_INFINITY, height: 900 },
        ];
        for (const size of degenerate) {
            expect(fitScale('stage', 'fit', size, DESIGN)).toBe(1);
            expect(fitScale('stage', 'fill', size, DESIGN)).toBe(1);
            expect(fitScale('stage', 'fit', WIDE, size)).toBe(1);
            expect(fitScale('stage', 'fill', WIDE, size)).toBe(1);
        }
    });
});

describe('isLetterboxed', () => {
    it("is true ONLY for 'stage' framing + 'fit' + letterbox", () => {
        expect(isLetterboxed('stage', 'fit', true)).toBe(true);
    });

    it('is false for every other combination of framing, mode and flag', () => {
        for (const framing of FRAMINGS) {
            for (const mode of MODES) {
                for (const letterbox of [true, false]) {
                    if (framing === 'stage' && mode === 'fit' && letterbox) continue;
                    expect(isLetterboxed(framing, mode, letterbox)).toBe(false);
                }
            }
        }
    });

    it('is false under fill and expand even with letterbox on — the settled decision', () => {
        expect(isLetterboxed('stage', 'fill', true)).toBe(false);
        expect(isLetterboxed('stage', 'expand', true)).toBe(false);
    });

    it("is false under 'free' framing even for fit + letterbox", () => {
        expect(isLetterboxed('free', 'fit', true)).toBe(false);
    });
});

describe('stageRect', () => {
    it('centers the scaled design rect and returns screen space, so bottom > top', () => {
        // s = 1.5 -> 1200x900 inside 1600x900: bars on the LEFT and RIGHT.
        const rect = stageRect('stage', 'fit', WIDE, DESIGN);
        expect(rect).toEqual({ left: 200, right: 1400, top: 0, bottom: 900 });
        expect(rect.bottom).toBeGreaterThan(rect.top);
        expect(boundsWidth(rect)).toBe(1200);
        expect(boundsHeight(rect)).toBe(900);
    });

    it('puts the bars on the top and bottom for a taller-than-design canvas', () => {
        // s = 1 -> 800x600 inside 800x1800.
        expect(stageRect('stage', 'fit', TALL, DESIGN)).toEqual({
            left: 0,
            right: 800,
            top: 600,
            bottom: 1200,
        });
    });

    it('overflows the canvas under fill — that is what "crops" means', () => {
        // s = 2 -> 1600x1200 inside 1600x900, so 150 px hangs off each of top and bottom.
        expect(stageRect('stage', 'fill', WIDE, DESIGN)).toEqual({
            left: 0,
            right: 1600,
            top: -150,
            bottom: 1050,
        });
    });

    it('is the unscaled design rect centered under expand', () => {
        // s = 1 -> 800x600 centered in 1600x900.
        expect(stageRect('stage', 'expand', WIDE, DESIGN)).toEqual({
            left: 400,
            right: 1200,
            top: 150,
            bottom: 750,
        });
    });

    it("is the FULL canvas under 'free' framing regardless of mode", () => {
        for (const mode of MODES) {
            expect(stageRect('free', mode, WIDE, DESIGN)).toEqual({
                left: 0,
                right: 1600,
                top: 0,
                bottom: 900,
            });
        }
    });

    it('writes into `out` and returns it', () => {
        const out = { left: -1, right: -1, top: -1, bottom: -1 };
        const returned = stageRect('stage', 'fit', WIDE, DESIGN, out);
        expect(returned).toBe(out);
        expect(out).toEqual({ left: 200, right: 1400, top: 0, bottom: 900 });
    });

    it('collapses to a point rather than NaN on a 0x0 canvas', () => {
        expect(stageRect('stage', 'fit', { width: 0, height: 0 }, DESIGN)).toEqual({
            left: -400,
            right: 400,
            top: -300,
            bottom: 300,
        });
    });
});

describe('visibleRect', () => {
    it('equals the stage rect when bars are actually drawn', () => {
        expect(visibleRect('stage', 'fit', true, WIDE, DESIGN)).toEqual(
            stageRect('stage', 'fit', WIDE, DESIGN),
        );
    });

    it('is the full canvas under fill, expand, no-letterbox and free framing', () => {
        const full = { left: 0, right: 1600, top: 0, bottom: 900 };
        expect(visibleRect('stage', 'fill', true, WIDE, DESIGN)).toEqual(full);
        expect(visibleRect('stage', 'expand', true, WIDE, DESIGN)).toEqual(full);
        expect(visibleRect('stage', 'fit', false, WIDE, DESIGN)).toEqual(full);
        expect(visibleRect('free', 'fit', true, WIDE, DESIGN)).toEqual(full);
    });
});

describe('worldViewport', () => {
    it("matches §4.2's design/(2*zoom) formula exactly under fit + letterbox", () => {
        for (const zoom of [1, 2, 0.5, 4, 0.25, 8]) {
            const halfW = DESIGN.width / (2 * zoom);
            const halfH = DESIGN.height / (2 * zoom);
            for (const canvas of [WIDE, TALL]) {
                expect(worldViewport(camera(120, -80, zoom), 'fit', true, canvas, DESIGN)).toEqual({
                    left: 120 - halfW,
                    right: 120 + halfW,
                    top: -80 + halfH,
                    bottom: -80 - halfH,
                });
            }
        }
    });

    it('is centered on the camera and independent of canvas size under fit + letterbox', () => {
        // The whole point of `fit`: everyone sees the same world.
        expect(worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN)).toEqual(
            worldViewport(camera(0, 0, 1), 'fit', true, TALL, DESIGN),
        );
        expect(worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN)).toEqual({
            left: -400,
            right: 400,
            top: 300,
            bottom: -300,
        });
    });

    it('keeps top > bottom — the y-up orientation of §4.2', () => {
        for (const mode of MODES) {
            for (const letterbox of [true, false]) {
                for (const canvas of [WIDE, TALL]) {
                    const rect = worldViewport(camera(5, -5, 2), mode, letterbox, canvas, DESIGN);
                    expect(rect.top).toBeGreaterThan(rect.bottom);
                    expect(rect.right).toBeGreaterThan(rect.left);
                }
            }
        }
    });

    it('halves the extent when zoom doubles', () => {
        const at1 = worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN);
        const at2 = worldViewport(camera(0, 0, 2), 'fit', true, WIDE, DESIGN);
        expect(boundsWidth(at2)).toBe(boundsWidth(at1) / 2);
        expect(boundsHeight(at2)).toBe(boundsHeight(at1) / 2);
        expect(at2).toEqual({ left: -200, right: 200, top: 150, bottom: -150 });
    });

    it('CROPS under fill: the non-governing axis shows less world than the design stage', () => {
        // s = 2, visible = the full 1600x900 canvas.
        // halfW = 1600/(2*2) = 400 = design.width/2 exactly (the width governs `max`);
        // halfH =  900/(2*2) = 225 < 300 = design.height/2 -> the crop.
        const rect = worldViewport(camera(0, 0, 1), 'fill', true, WIDE, DESIGN);
        expect(rect).toEqual({ left: -400, right: 400, top: 225, bottom: -225 });
        expect(boundsHeight(rect)).toBeLessThan(DESIGN.height);
        expect(boundsWidth(rect)).toBe(DESIGN.width);

        // On the tall canvas the other axis crops instead: s = 3,
        // halfW = 800/(2*3) = 133.33 < 400, halfH = 1800/(2*3) = 300 = design.height/2.
        const tall = worldViewport(camera(0, 0, 1), 'fill', true, TALL, DESIGN);
        expect(boundsWidth(tall)).toBeLessThan(DESIGN.width);
        expect(boundsHeight(tall)).toBe(DESIGN.height);
    });

    it('SEES MORE WORLD under expand, and more still on a bigger canvas', () => {
        // s = 1, so the world extent IS the canvas extent.
        const rect = worldViewport(camera(0, 0, 1), 'expand', true, WIDE, DESIGN);
        expect(rect).toEqual({ left: -800, right: 800, top: 450, bottom: -450 });
        expect(boundsWidth(rect)).toBeGreaterThan(DESIGN.width);
        expect(boundsHeight(rect)).toBeGreaterThan(DESIGN.height);

        const bigger = worldViewport(
            camera(0, 0, 1),
            'expand',
            true,
            { width: 3200, height: 1800 },
            DESIGN,
        );
        expect(boundsWidth(bigger)).toBe(3200);
        expect(boundsWidth(bigger)).toBeGreaterThan(boundsWidth(rect));
        expect(boundsHeight(bigger)).toBeGreaterThan(boundsHeight(rect));
    });

    it('sees more world under fit with letterbox OFF — the bars become world, not bars', () => {
        // s = 1.5, visible = the full canvas: halfW = 1600/(2*1.5) = 533.33 > 400.
        const rect = worldViewport(camera(0, 0, 1), 'fit', false, WIDE, DESIGN);
        expect(rect.right).toBeCloseTo(1600 / 3, 12);
        expect(boundsWidth(rect)).toBeGreaterThan(DESIGN.width);
        // The governing axis is unchanged: 900/(2*1.5) = 300 = design.height/2.
        expect(boundsHeight(rect)).toBe(DESIGN.height);
    });

    it("reads framing off the camera, defaulting to 'stage'", () => {
        const implicit = worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN);
        expect(worldViewport(camera(0, 0, 1, 'stage'), 'fit', true, WIDE, DESIGN)).toEqual(
            implicit,
        );

        // 'free' forces fitScale to 1 AND letterboxing off, so the extent is the raw canvas.
        expect(worldViewport(camera(0, 0, 1, 'free'), 'fit', true, WIDE, DESIGN)).toEqual({
            left: -800,
            right: 800,
            top: 450,
            bottom: -450,
        });
        // Under 'free', zoom is literal px per world unit: 2 px/unit halves the extent.
        expect(worldViewport(camera(0, 0, 2, 'free'), 'fit', true, WIDE, DESIGN)).toEqual({
            left: -400,
            right: 400,
            top: 225,
            bottom: -225,
        });
    });

    it('writes into `out` and returns it', () => {
        const out = { left: -1, right: -1, top: -1, bottom: -1 };
        const returned = worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN, out);
        expect(returned).toBe(out);
        expect(out).toEqual({ left: -400, right: 400, top: 300, bottom: -300 });
    });

    describe('degenerate input is clamped, never NaN or Infinity', () => {
        const ZERO = { width: 0, height: 0 };

        it('collapses to a zero-extent rect at the camera when not letterboxed', () => {
            // The visible rect is the empty canvas, so the half-extents are 0.
            expect(worldViewport(camera(7, -3, 1), 'fit', false, ZERO, DESIGN)).toEqual({
                left: 7,
                right: 7,
                top: -3,
                bottom: -3,
            });
            expect(worldViewport(camera(7, -3, 1), 'expand', true, ZERO, DESIGN)).toEqual({
                left: 7,
                right: 7,
                top: -3,
                bottom: -3,
            });
        });

        it('degrades to the design stage at the camera under fit + letterbox', () => {
            // `fitScale` falls back to 1 and the visible rect is the design rect, so this is
            // the §4.2 formula with s = 1 — still finite, which is all that is required.
            expect(worldViewport(camera(7, -3, 1), 'fit', true, ZERO, DESIGN)).toEqual({
                left: -393,
                right: 407,
                top: 297,
                bottom: -303,
            });
        });

        it('treats a non-positive or NaN zoom as 1', () => {
            const at1 = worldViewport(camera(0, 0, 1), 'fit', true, WIDE, DESIGN);
            for (const zoom of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(worldViewport(camera(0, 0, zoom), 'fit', true, WIDE, DESIGN)).toEqual(at1);
            }
        });

        it('treats a non-finite camera position as the origin', () => {
            const rect = worldViewport(
                { position: { x: Number.NaN, y: Number.POSITIVE_INFINITY }, zoom: 1 },
                'fit',
                true,
                WIDE,
                DESIGN,
            );
            expect(rect).toEqual({ left: -400, right: 400, top: 300, bottom: -300 });
        });

        it('stays finite for every combination of degenerate size and mode', () => {
            const sizes = [
                { width: 0, height: 0 },
                { width: -1600, height: -900 },
                { width: Number.NaN, height: Number.NaN },
                { width: Number.POSITIVE_INFINITY, height: 900 },
            ];
            for (const canvas of sizes) {
                for (const design of [DESIGN, ...sizes]) {
                    for (const mode of MODES) {
                        const rect = worldViewport(camera(0, 0, 1), mode, true, canvas, design);
                        for (const edge of [rect.left, rect.right, rect.top, rect.bottom]) {
                            expect(Number.isFinite(edge)).toBe(true);
                        }
                    }
                }
            }
        });

        // The dangerous degenerate inputs are not the obviously-bad ones above — those are
        // caught by the `positiveOr` guards. These are inputs where every INDIVIDUAL number
        // is an ordinary finite positive and only the arithmetic between them breaks.
        it('stays finite for a very small but finite zoom', () => {
            // `visible / (2 * scale * zoom)` overflows to Infinity from about 1e-306 down on
            // this stage, and Infinity in `camera.viewport` culls every node forever.
            for (const zoom of [1e-6, 1e-300, 1e-306, 1e-308, 1e-320, 5e-324]) {
                for (const mode of MODES) {
                    for (const letterbox of [true, false]) {
                        const rect = worldViewport(
                            camera(0, 0, zoom),
                            mode,
                            letterbox,
                            WIDE,
                            DESIGN,
                        );
                        for (const edge of [rect.left, rect.right, rect.top, rect.bottom]) {
                            expect(Number.isFinite(edge)).toBe(true);
                        }
                        expect(rect.top).toBeGreaterThanOrEqual(rect.bottom);
                    }
                }
            }
        });

        it('stays finite for an extreme but finite canvas:design RATIO', () => {
            // `cw / dw` alone overflows to Infinity or underflows to 0 here. A 0 scale then
            // makes the half-extent 0/0 = NaN — the exact value this module exists to keep
            // out of `camera.viewport`.
            const ratios = [
                [1e300, 1e-300],
                [4096, 1e-320],
                [1e-300, 1e300],
                [1e-320, 1e308],
                [1, 1e308],
            ] as const;
            for (const [c, d] of ratios) {
                const canvas = { width: c, height: c };
                const design = { width: d, height: d };
                expect(Number.isFinite(fitScale('stage', 'fit', canvas, design))).toBe(true);
                expect(fitScale('stage', 'fit', canvas, design)).toBeGreaterThan(0);
                for (const mode of MODES) {
                    for (const letterbox of [true, false]) {
                        const rect = worldViewport(
                            camera(0, 0, 1),
                            mode,
                            letterbox,
                            canvas,
                            design,
                        );
                        for (const edge of [rect.left, rect.right, rect.top, rect.bottom]) {
                            expect(Number.isFinite(edge)).toBe(true);
                        }
                        const stage = stageRect('stage', mode, canvas, design);
                        for (const edge of [stage.left, stage.right, stage.top, stage.bottom]) {
                            expect(Number.isFinite(edge)).toBe(true);
                        }
                    }
                }
            }
        });
    });

    // §4.2's promise under `fit` is that "everyone sees the same world". Computing the
    // half-extent as `design * s / (2 * s * zoom)` rounds twice and lands 1 ulp off on any
    // canvas whose `fitScale` is not a dyadic rational, which makes the viewport differ per
    // client under the one mode whose whole purpose is that it must not.
    describe('canvas-independence under fit + letterbox is BIT-exact, not approximate', () => {
        const REAL_CANVASES = [
            { width: 1600, height: 900 },
            { width: 1366, height: 768 }, // fitScale 1.4229... — the one that used to drift
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
            { width: 1000, height: 700 },
            { width: 1512, height: 982 },
            { width: 3024, height: 1964 },
            { width: 1023, height: 769 },
            { width: 100, height: 100 },
        ];

        it('is exactly §4.2 on every real canvas size, for several designs and zooms', () => {
            for (const design of [
                DESIGN,
                { width: 960, height: 540 },
                { width: 1024, height: 768 },
            ]) {
                for (const zoom of [1, 2, 0.5, 3, 0.25]) {
                    for (const canvas of REAL_CANVASES) {
                        expect(
                            worldViewport(camera(120, -80, zoom), 'fit', true, canvas, design),
                        ).toEqual({
                            left: 120 - design.width / (2 * zoom),
                            right: 120 + design.width / (2 * zoom),
                            top: -80 + design.height / (2 * zoom),
                            bottom: -80 - design.height / (2 * zoom),
                        });
                    }
                }
            }
        });

        it('gives byte-identical rects across all of them — one distinct value', () => {
            const distinct = new Set(
                REAL_CANVASES.map((canvas) =>
                    JSON.stringify(
                        worldViewport(camera(0, 0, 1), 'fit', true, canvas, {
                            width: 960,
                            height: 540,
                        }),
                    ),
                ),
            );
            expect(distinct.size).toBe(1);
            expect([...distinct][0]).toBe(
                JSON.stringify({ left: -480, right: 480, top: 270, bottom: -270 }),
            );
        });
    });
});

describe('effectiveResolution', () => {
    it('caps the DPR at maxResolution', () => {
        expect(effectiveResolution(3, 2)).toBe(2);
        expect(effectiveResolution(2.5, 2)).toBe(2);
        expect(effectiveResolution(4, 1.5)).toBe(1.5);
    });

    it('passes a DPR below the cap through unchanged', () => {
        expect(effectiveResolution(1, 2)).toBe(1);
        expect(effectiveResolution(1.5, 2)).toBe(1.5);
        expect(effectiveResolution(2, 2)).toBe(2);
    });

    it('floors at 1, so a sub-1 DPR or cap never shrinks the backbuffer', () => {
        expect(effectiveResolution(0.5, 2)).toBe(1);
        expect(effectiveResolution(2, 0.5)).toBe(1);
        expect(effectiveResolution(0.5, 0.5)).toBe(1);
        expect(effectiveResolution(2, 0)).toBe(1);
        expect(effectiveResolution(2, -1)).toBe(1);
    });

    it('treats a non-finite DPR as 1 and an infinite cap as no cap', () => {
        expect(effectiveResolution(Number.NaN, 2)).toBe(1);
        expect(effectiveResolution(Number.POSITIVE_INFINITY, 2)).toBe(1);
        expect(effectiveResolution(3, Number.POSITIVE_INFINITY)).toBe(3);
    });
});

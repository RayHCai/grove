// PURE. Framing and scale mode -> fitScale, the stage rect, and the world viewport
// (§4.1, §4.2). Reads no globals — the DPR is passed in — so this runs in plain Node.
//
// TWO RECTANGLES, EASY TO CONFLATE. `stageRect` is the design stage mapped onto the canvas
// and is what UI anchors against; `visibleRect` is the screen region world content actually
// occupies. They coincide ONLY when bars are really drawn, which is 'stage' framing plus
// 'fit' plus `letterbox`. Under 'fill' the scaled design rect OVERFLOWS the canvas — that
// is what §4.2's "crops" means — and under 'expand' the canvas is simply larger than the
// stage, so in both of those cases world content owns the FULL canvas.
//
// NOTHING HERE THROWS. Option validation belongs to the renderer. Degenerate input — a
// container measured as 0x0 mid-layout, a zoom of 0 — is clamped to a finite answer,
// because a NaN reaching `camera.viewport` would poison every frame after it and give no
// hint where it came from.

import { bounds, boundsHeight, boundsSet, boundsWidth } from '@platform/math';
import type { Bounds, Size } from '@platform/math';
import type { CameraState, Framing, ScaleMode } from './renderer.js';

/** `value` when it is finite and positive, else `fallback`. Guards extents and zoom. */
function positiveOr(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `value` when it is finite, else `fallback`. For coordinates, which may be negative. */
function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * The largest half-extent a viewport may report.
 *
 * `visible / (2 * scale * zoom)` overflows to Infinity for a legitimately finite but very
 * small `zoom` — a stage-framed 800x600 design starts overflowing around `zoom = 1e-306`,
 * well inside the double range. Capping keeps the promise the rest of this module makes:
 * the rect is always finite. The cap is far larger than any real world and small enough
 * that adding any finite camera position to it cannot overflow either.
 */
const MAX_HALF_EXTENT = Number.MAX_SAFE_INTEGER;

/** A half-extent that is finite and non-negative whatever the arithmetic produced. */
function safeHalfExtent(value: number): number {
    if (Number.isNaN(value) || value < 0) return 0;
    return value > MAX_HALF_EXTENT ? MAX_HALF_EXTENT : value;
}

/**
 * Scale from design px to CSS px, before `zoom` (§4.1, §4.2).
 *
 * `'free'` framing is always 1: the editor's `zoom` is literal px per world unit, so the
 * design stage does not participate at all. `'expand'` is 1 for the same reason on a game
 * stage — a bigger screen shows more world rather than bigger world.
 *
 * Returns 1 for a degenerate canvas or design size, since every caller divides by this.
 * That guard covers the RATIO as well as the two sizes: an extreme canvas:design ratio
 * overflows `cw / dw` to Infinity or underflows it to 0 even though both inputs are
 * ordinary finite positives, and either one divided into a viewport half-extent yields
 * Infinity or — the value this whole module exists to keep out of `camera.viewport` — NaN.
 */
export function fitScale(
    framing: Framing,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
): number {
    if (framing === 'free' || scaleMode === 'expand') return 1;

    const cw = positiveOr(canvas.width, 0);
    const ch = positiveOr(canvas.height, 0);
    const dw = positiveOr(design.width, 0);
    const dh = positiveOr(design.height, 0);
    if (cw === 0 || ch === 0 || dw === 0 || dh === 0) return 1;

    const sx = cw / dw;
    const sy = ch / dh;
    const scale = scaleMode === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy);
    return positiveOr(scale, 1);
}

/**
 * `true` when letterbox bars are actually drawn.
 *
 * Only 'stage' framing + 'fit' + `letterbox` qualifies. `fill` crops and `expand` reveals
 * more world; in both the content reaches every canvas edge, so there is nothing to bar.
 * `'free'` framing forces letterboxing off outright (§4.1).
 */
export function isLetterboxed(framing: Framing, scaleMode: ScaleMode, letterbox: boolean): boolean {
    return framing === 'stage' && scaleMode === 'fit' && letterbox;
}

/**
 * The stage in SCREEN space — y-down, so `bottom > top`.
 *
 * Under `'stage'` this is the design rect scaled by `fitScale` and centered on the canvas;
 * under `'free'` the infinite editor canvas has no stage, so the whole canvas is it (§4.1).
 *
 * Under `'fill'` the scaled rect is LARGER than the canvas, so the returned edges fall
 * outside it (a negative `top`, a `right` past `canvas.width`). That is deliberate: UI is
 * authored against the stage, and `fill` cropping the edges of a HUD is the same tradeoff
 * as it cropping the edges of the world.
 */
export function stageRect(
    framing: Framing,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
    out: Bounds = bounds(),
): Bounds {
    const cw = positiveOr(canvas.width, 0);
    const ch = positiveOr(canvas.height, 0);
    if (framing === 'free') return boundsSet(out, 0, cw, 0, ch);

    const scale = fitScale(framing, scaleMode, canvas, design);
    const sw = positiveOr(design.width, 0) * scale;
    const sh = positiveOr(design.height, 0) * scale;
    const left = (cw - sw) / 2;
    const top = (ch - sh) / 2;
    return boundsSet(out, left, left + sw, top, top + sh);
}

/**
 * The screen region (CSS px, y-down) world content actually occupies: the stage when bars
 * are drawn, otherwise the whole canvas.
 */
export function visibleRect(
    framing: Framing,
    scaleMode: ScaleMode,
    letterbox: boolean,
    canvas: Size,
    design: Size,
    out: Bounds = bounds(),
): Bounds {
    if (isLetterboxed(framing, scaleMode, letterbox)) {
        return stageRect(framing, scaleMode, canvas, design, out);
    }
    return boundsSet(out, 0, positiveOr(canvas.width, 0), 0, positiveOr(canvas.height, 0));
}

/**
 * The world-space rect on screen right now. This is what feeds `camera.viewport`.
 *
 * y-up, so `top > bottom` (§4.2). Framing comes off the camera, defaulting to `'stage'`.
 *
 * The half-extents are the visible screen region divided by px-per-world-unit. Under
 * fit + letterbox the visible region is `design * fitScale`, so that ALGEBRAICALLY reduces
 * to §4.2's `design / (2 * zoom)` — but not in floating point: `design.width * s / (2 * s *
 * zoom)` rounds twice and lands 1 ulp off the stated formula on canvases where `s` is not a
 * dyadic rational (1366x768 against a 960x540 design gives 480.00000000000006, not 480).
 * That would make the viewport differ per canvas under the one mode whose entire purpose is
 * that "everyone sees the same world" (§4.2). So the letterboxed case evaluates §4.2's
 * formula DIRECTLY, cancelling `s` symbolically, and is bit-identical on every canvas.
 *
 * A 0x0 canvas — a container measured mid-layout — never produces a NaN rect. Under
 * fit + letterbox it degrades to the design stage at the camera, because `fitScale` falls
 * back to 1 and the visible rect is then the design rect; otherwise the visible rect is the
 * empty canvas and the result is a zero-extent rect AT the camera, so everything culls until
 * the first real resize replaces it. Either way the edges are finite, which is the whole
 * point: a NaN reaching `camera.viewport` would poison every later frame.
 *
 * The four edges are ALWAYS finite, not only for the obvious degenerate inputs. A very small
 * `zoom` (below ~1e-306 on a stage-framed 800x600) or an extreme canvas:design ratio pushes
 * the division to Infinity or 0/0 from inputs that are each individually ordinary, so the
 * half-extents are clamped rather than trusted.
 */
export function worldViewport(
    camera: Readonly<CameraState>,
    scaleMode: ScaleMode,
    letterbox: boolean,
    canvas: Size,
    design: Size,
    out: Bounds = bounds(),
): Bounds {
    const framing = camera.framing ?? 'stage';
    const zoom = positiveOr(camera.zoom, 1);

    let halfW: number;
    let halfH: number;
    if (isLetterboxed(framing, scaleMode, letterbox)) {
        // §4.2 evaluated directly. `fitScale` cancels, so it must NOT appear here: dividing
        // by it after multiplying by it costs a rounding step and makes the "same world for
        // everyone" guarantee canvas-dependent in the last bit.
        const denominator = 2 * zoom;
        halfW = safeHalfExtent(positiveOr(design.width, 0) / denominator);
        halfH = safeHalfExtent(positiveOr(design.height, 0) / denominator);
    } else {
        // `out` doubles as scratch: the visible rect is fully consumed into the half-extents
        // before the world edges overwrite it, which keeps this allocation-free.
        visibleRect(framing, scaleMode, letterbox, canvas, design, out);
        const perWorldUnit = 2 * fitScale(framing, scaleMode, canvas, design) * zoom;
        halfW = safeHalfExtent(boundsWidth(out) / perWorldUnit);
        halfH = safeHalfExtent(boundsHeight(out) / perWorldUnit);
    }

    const cx = finiteOr(camera.position.x, 0);
    const cy = finiteOr(camera.position.y, 0);
    return boundsSet(out, cx - halfW, cx + halfW, cy + halfH, cy - halfH);
}

/**
 * The device pixel ratio actually usable: `min(devicePixelRatio, maxResolution)`, floored
 * at 1. Takes the DPR as an argument because this module reads no globals.
 *
 * The floor means a `maxResolution` below 1 is ignored rather than shrinking the backbuffer
 * below CSS resolution. An infinite cap is honoured as "no cap".
 */
export function effectiveResolution(devicePixelRatio: number, maxResolution: number): number {
    const dpr = positiveOr(devicePixelRatio, 1);
    const cap = maxResolution > 0 ? maxResolution : 1;
    return Math.max(1, Math.min(dpr, cap));
}

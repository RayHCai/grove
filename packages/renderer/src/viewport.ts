// Reads no globals — the DPR is passed in. `stageRect` is the design stage mapped onto the canvas;
// `visibleRect` is the screen region world content occupies; they coincide only when bars are
// drawn. Nothing here throws: option validation belongs to the renderer.

import { bounds, boundsHeight, boundsSet, boundsWidth, finiteOr, positiveOr } from '@platform/math';
import type { Bounds, Size } from '@platform/math';
import type { CameraState, Framing, ScaleMode } from './renderer.js';

/** The largest half-extent a viewport may report; a tiny `zoom` would otherwise overflow it. */
const MAX_HALF_EXTENT = Number.MAX_SAFE_INTEGER;

/** A half-extent that is finite and non-negative whatever the arithmetic produced. */
function safeHalfExtent(value: number): number {
    if (Number.isNaN(value) || value < 0) return 0;
    return value > MAX_HALF_EXTENT ? MAX_HALF_EXTENT : value;
}

/**
 * Scale from design px to CSS px, before `zoom`; `'free'` and `'expand'` are always 1.
 * Falls back to 1 for a degenerate size or ratio, since every caller divides by this.
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

/** `true` when letterbox bars are drawn; `fill` crops and `expand` reveals, so neither bars. */
export function isLetterboxed(framing: Framing, scaleMode: ScaleMode, letterbox: boolean): boolean {
    return framing === 'stage' && scaleMode === 'fit' && letterbox;
}

/**
 * The stage in screen space — y-down, so `bottom > top`.
 * `'free'` has no stage, so the canvas is it; `'fill'` crops a HUD exactly as it crops the world.
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
 * The world-space rect on screen right now, y-up (`top > bottom`). Feeds `camera.viewport`.
 * Under fit + letterbox `s` cancels symbolically; rounding twice would land 1 ulp off.
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
        // `fitScale` cancels, so it must not appear here — see the doc comment above.
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

/** The usable DPR: `min(devicePixelRatio, maxResolution)`, floored at 1 so a <1 cap is ignored. */
export function effectiveResolution(devicePixelRatio: number, maxResolution: number): number {
    const dpr = positiveOr(devicePixelRatio, 1);
    const cap = maxResolution > 0 ? maxResolution : 1;
    return Math.max(1, Math.min(dpr, cap));
}

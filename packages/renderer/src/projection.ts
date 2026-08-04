// PURE. World <-> screen, the y-flip, degrees -> Pixi radians, and UI anchors (§6.3, §6.4).
//
// THE Y-FLIP IS ARITHMETIC AT THE WRITE BOUNDARY, in this file and nowhere else. The
// tempting `root.scale.y = -1` is wrong: a negative root scale mirrors every sprite and
// every glyph in the tree. So the flip is a sign on the value we hand the backend —
// `pixi.y = -local.y`, `pixi.rotation = -degrees * DEG2RAD` — and the camera root keeps a
// POSITIVE uniform scale (§6.3, §6.4).
//
// Three spaces meet here, and the y direction differs between them (§3):
//
//   world   origin stage-center, y-UP,   world px
//   ui      origin a named anchor, y-DOWN, DESIGN px scaled by fitScale
//   screen  origin canvas top-left, y-DOWN, CSS px
//
// UI stays y-down because §12.1 defines placement as an anchor plus an offset, and
// `{uiAnchor: 'top-left', position: {x: 20, y: 20}}` has to read as "20 in from the left,
// 20 DOWN from the top" — under y-up that offset would point off-screen.
//
// `z` passes through every function unchanged: present-but-reserved for a 3D backend (§17).

import { DEG2RAD, vec3, vec3Set } from '@platform/math';
import type { Bounds, MutableVec3, Size, Vec3Like } from '@platform/math';
import type { CameraState, ScaleMode, UiAnchor } from './renderer.js';
// Aliased so `uiToScreen`'s `fitScale` PARAMETER — the name the caller sees — does not
// shadow this import.
import { fitScale as stageFitScale } from './viewport.js';

/** `value` when it is finite and positive, else `fallback`. */
function positiveOr(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `value` when it is finite, else `fallback`. For coordinates, which may be negative. */
function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

/** Fractional position of each anchor within the stage rect. y is measured DOWN (§3). */
const UI_ANCHOR_FRACTION: Record<UiAnchor, { x: number; y: number }> = {
    'top-left': { x: 0, y: 0 },
    'top-center': { x: 0.5, y: 0 },
    'top-right': { x: 1, y: 0 },
    'middle-left': { x: 0, y: 0.5 },
    center: { x: 0.5, y: 0.5 },
    'middle-right': { x: 1, y: 0.5 },
    'bottom-left': { x: 0, y: 1 },
    'bottom-center': { x: 0.5, y: 1 },
    'bottom-right': { x: 1, y: 1 },
};

/**
 * Interpolates between two edges.
 *
 * The endpoints are returned verbatim rather than as `lo + f * (hi - lo)`, which is not
 * exactly `hi` at `f === 1` in floating point. An anchored HUD element must land ON the
 * stage edge, not a rounding error away from it.
 */
function edge(lo: number, hi: number, fraction: number): number {
    if (fraction === 0) return lo;
    if (fraction === 1) return hi;
    return lo + (hi - lo) * fraction;
}

/**
 * Composed camera scale: `fitScale * zoom` — CSS px per world unit (§6.4).
 *
 * Framing comes off the camera, defaulting to `'stage'`. Guaranteed finite and positive:
 * a non-positive or NaN `zoom` falls back to 1, so no projection can divide by zero and
 * `worldToScreen` / `screenToWorld` stay exact inverses whatever they are handed.
 */
export function cameraScale(
    camera: Readonly<CameraState>,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
): number {
    const scale = stageFitScale(camera.framing ?? 'stage', scaleMode, canvas, design);
    return positiveOr(scale * positiveOr(camera.zoom, 1), 1);
}

/**
 * Pixi rotation, in radians, from authored degrees.
 *
 * Authored rotation is CCW-positive in a y-up world; the backend's y-down space makes the
 * same visual turn CW-positive, so the sign flips. This is the rotation half of §6.3 — the
 * companion to {@link flipY}, and the reason a root `scale.y = -1` is not needed.
 */
export function pixiRotation(degrees: number): number {
    return -degrees * DEG2RAD;
}

/** The backend-space y for a world y: the write-boundary flip (§6.3). */
export function flipY(y: number): number {
    return -y;
}

/**
 * World -> screen, in CSS px with y DOWN (§6.4).
 *
 * `screenX = cw/2 + (wx - cam.x) * s`, `screenY = ch/2 + (cam.y - wy) * s`. Note the
 * REVERSED subtraction on y: that is the flip, and it means a point ABOVE the camera in
 * world space gets a SMALLER screen y.
 */
export function worldToScreen(
    point: Vec3Like,
    camera: Readonly<CameraState>,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
    out: MutableVec3 = vec3(),
): MutableVec3 {
    const s = cameraScale(camera, scaleMode, canvas, design);
    const cx = finiteOr(camera.position.x, 0);
    const cy = finiteOr(camera.position.y, 0);
    const halfCanvasW = positiveOr(canvas.width, 0) / 2;
    const halfCanvasH = positiveOr(canvas.height, 0) / 2;

    return vec3Set(
        out,
        halfCanvasW + (point.x - cx) * s,
        halfCanvasH + (cy - point.y) * s,
        point.z ?? 0,
    );
}

/** The exact inverse of {@link worldToScreen}. Screen y down, world y up. */
export function screenToWorld(
    point: Vec3Like,
    camera: Readonly<CameraState>,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
    out: MutableVec3 = vec3(),
): MutableVec3 {
    const s = cameraScale(camera, scaleMode, canvas, design);
    const cx = finiteOr(camera.position.x, 0);
    const cy = finiteOr(camera.position.y, 0);
    const halfCanvasW = positiveOr(canvas.width, 0) / 2;
    const halfCanvasH = positiveOr(canvas.height, 0) / 2;

    return vec3Set(
        out,
        cx + (point.x - halfCanvasW) / s,
        cy - (point.y - halfCanvasH) / s,
        point.z ?? 0,
    );
}

/**
 * The screen-space (CSS px) point a {@link UiAnchor} names on a stage rect (§3, §12.1).
 *
 * `stage` is screen space, so `bottom > top` — which makes `'top-left'` the rect's
 * numerically SMALLEST corner and `'bottom-right'` its largest.
 */
export function uiAnchorOrigin(anchor: UiAnchor, stage: Bounds, out: MutableVec3 = vec3()): MutableVec3 {
    const fraction = UI_ANCHOR_FRACTION[anchor];
    return vec3Set(
        out,
        edge(stage.left, stage.right, fraction.x),
        edge(stage.top, stage.bottom, fraction.y),
        0,
    );
}

/**
 * A UI node's screen position: its anchor origin plus its design-px offset scaled by
 * `fitScale` (§3).
 *
 * The offset is ADDED on both axes because UI is y-down like screen space, so
 * `{uiAnchor: 'top-left', position: {x: 20, y: 20}}` is 20 design px in from the left and
 * 20 design px down from the top. Scaling by `fitScale` is what makes a HUD authored
 * against the design stage land identically on every screen.
 */
export function uiToScreen(
    offset: Vec3Like,
    anchor: UiAnchor,
    stage: Bounds,
    fitScale: number,
    out: MutableVec3 = vec3(),
): MutableVec3 {
    // `offset` is read into locals BEFORE `out` is written, so `out` may safely be the same
    // object as `offset` — the pooled-scratch call `uiToScreen(p, anchor, stage, s, p)`.
    // Writing the anchor origin into `out` first would clobber the offset in that case.
    const s = positiveOr(fitScale, 1);
    const dx = offset.x * s;
    const dy = offset.y * s;
    const dz = offset.z ?? 0;

    uiAnchorOrigin(anchor, stage, out);
    return vec3Set(out, out.x + dx, out.y + dy, dz);
}

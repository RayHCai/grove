// Pure. The y-flip is arithmetic at the write boundary, in this file and nowhere else: the
// tempting `root.scale.y = -1` mirrors every sprite and glyph in the tree, so the flip is a sign
// on the value handed to the backend and the camera root keeps a positive uniform scale.
//
// Three spaces meet here, and the y direction differs between them:
//
//   world   origin stage-center,      y-up,   world px
//   ui      origin a named anchor,    y-down, design px scaled by fitScale
//   screen  origin canvas top-left,   y-down, CSS px
//
// `z` passes through every function unchanged, reserved for a 3D backend.

import { DEG2RAD, finiteOr, positiveOr, vec3, vec3Set } from '@platform/math';
import type { Bounds, MutableVec3, Size, Vec3Like } from '@platform/math';
import type { CameraState, ScaleMode, UiAnchor } from './renderer.js';
// Aliased so `uiToScreen`'s `fitScale` parameter does not shadow this import.
import { fitScale as stageFitScale } from './viewport.js';

/** Fractional position of each anchor within the stage rect. y is measured down. */
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
 * The endpoints are returned verbatim because `lo + f * (hi - lo)` is not exactly `hi` at
 * `f === 1`, and an anchored HUD element must land on the stage edge.
 */
function edge(lo: number, hi: number, fraction: number): number {
    if (fraction === 0) return lo;
    if (fraction === 1) return hi;
    return lo + (hi - lo) * fraction;
}

/**
 * Composed camera scale: `fitScale * zoom` — CSS px per world unit.
 *
 * Always finite and positive, so no projection divides by zero and `worldToScreen` /
 * `screenToWorld` stay exact inverses whatever they are handed.
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
 * Authored rotation is CCW-positive in a y-up world; the backend's y-down space makes the same
 * visual turn CW-positive, so the sign flips.
 */
export function pixiRotation(degrees: number): number {
    return -degrees * DEG2RAD;
}

/** The backend-space y for a world y: the write-boundary flip. */
export function flipY(y: number): number {
    return -y;
}

/**
 * World -> screen, in CSS px with y down.
 *
 * The reversed subtraction on y is the flip: a point above the camera in world space gets a
 * smaller screen y.
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
 * The screen-space (CSS px) point a {@link UiAnchor} names on a stage rect.
 *
 * `stage` is screen space, so `bottom > top` — which makes `'top-left'` the rect's numerically
 * smallest corner and `'bottom-right'` its largest.
 */
export function uiAnchorOrigin(
    anchor: UiAnchor,
    stage: Bounds,
    out: MutableVec3 = vec3(),
): MutableVec3 {
    const fraction = UI_ANCHOR_FRACTION[anchor];
    return vec3Set(
        out,
        edge(stage.left, stage.right, fraction.x),
        edge(stage.top, stage.bottom, fraction.y),
        0,
    );
}

/**
 * A UI node's screen position: its anchor origin plus its design-px offset scaled by `fitScale`.
 *
 * The offset is added on both axes because UI is y-down like screen space, and scaling by
 * `fitScale` is what makes a HUD authored against the design stage land the same on every screen.
 */
export function uiToScreen(
    offset: Vec3Like,
    anchor: UiAnchor,
    stage: Bounds,
    fitScale: number,
    out: MutableVec3 = vec3(),
): MutableVec3 {
    // `offset` is read into locals before `out` is written, so a caller may pass the same object
    // as both; writing the anchor origin into `out` first would clobber the offset.
    const s = positiveOr(fitScale, 1);
    const dx = offset.x * s;
    const dy = offset.y * s;
    const dz = offset.z ?? 0;

    uiAnchorOrigin(anchor, stage, out);
    return vec3Set(out, out.x + dx, out.y + dy, dz);
}

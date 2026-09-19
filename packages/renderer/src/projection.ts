// The y-flip is arithmetic at the write boundary and nowhere else: `root.scale.y = -1` would
// mirror every sprite and glyph. Three spaces meet here and differ in y direction —
// world (stage-center, y-up, world px), ui (named anchor, y-down, design px), screen (canvas
// top-left, y-down, CSS px). `z` passes through unchanged, reserved for a 3D backend.

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

/** Interpolates between two edges; endpoints return verbatim, so an anchor lands on the edge. */
function edge(lo: number, hi: number, fraction: number): number {
    if (fraction === 0) return lo;
    if (fraction === 1) return hi;
    return lo + (hi - lo) * fraction;
}

/** Composed camera scale: `fitScale * zoom`, CSS px per world unit. Always finite and positive. */
export function cameraScale(
    camera: Readonly<CameraState>,
    scaleMode: ScaleMode,
    canvas: Size,
    design: Size,
): number {
    const scale = stageFitScale(camera.framing ?? 'stage', scaleMode, canvas, design);
    return positiveOr(scale * positiveOr(camera.zoom, 1), 1);
}

/** Pixi rotation in radians from authored degrees; the backend's y-down space flips the sign. */
export function pixiRotation(degrees: number): number {
    return -degrees * DEG2RAD;
}

/** The backend-space y for a world y: the write-boundary flip. */
export function flipY(y: number): number {
    return -y;
}

/** World → screen, CSS px with y down; the reversed subtraction on y is the flip. */
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

/** The screen-space point a {@link UiAnchor} names on a stage rect; `stage` is y-down. */
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

/** A UI node's screen position: anchor origin plus its design-px offset scaled by `fitScale`. */
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

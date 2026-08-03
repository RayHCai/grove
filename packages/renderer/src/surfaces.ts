// PURE. Surface order and the camera-transformed predicate (§4).
//
// Draw order is fixed bottom-to-top and is not configurable, so a UI node can never sort
// beneath a world node regardless of `layer`. `editorOverlay` sits above `ui` on purpose:
// a gizmo must stay grabbable over the widget it moves.

import type { Surface } from './renderer.js';

/** Every surface, bottom to top. Index in this array IS the draw order. */
export const SURFACE_ORDER: readonly Surface[] = [
    'editorSpace',
    'world',
    'ui',
    'editorOverlay',
    'editorUi',
] as const;

/** What `enabledSurfaces` defaults to: a shipped game allocates no editor containers. */
export const DEFAULT_SURFACES: readonly Surface[] = ['world', 'ui'] as const;

/** The three surfaces the shared camera transforms (§4). */
const CAMERA_TRANSFORMED: ReadonlySet<Surface> = new Set<Surface>([
    'editorSpace',
    'world',
    'editorOverlay',
]);

/**
 * The surfaces clipped to `stageRect` when letterboxing is active.
 *
 * Editor chrome is excluded so a bar never cuts off a gizmo or a panel — and `'free'`
 * framing (what the editor uses) forces letterboxing off anyway.
 */
const CLIPPED_WHEN_LETTERBOXED: ReadonlySet<Surface> = new Set<Surface>([
    'editorSpace',
    'world',
    'ui',
]);

/** Draw order of a surface: lower draws first. */
export function surfaceOrder(surface: Surface): number {
    return SURFACE_ORDER.indexOf(surface);
}

/** `true` for the surfaces the camera moves; `false` for the screen-space ones. */
export function isCameraTransformed(surface: Surface): boolean {
    return CAMERA_TRANSFORMED.has(surface);
}

/** `true` for the screen-space surfaces — `ui` and `editorUi`. */
export function isScreenSpace(surface: Surface): boolean {
    return !CAMERA_TRANSFORMED.has(surface);
}

/** `true` when this surface is masked to the stage rect while letterboxing. */
export function isClippedWhenLetterboxed(surface: Surface): boolean {
    return CLIPPED_WHEN_LETTERBOXED.has(surface);
}

/** `true` for a valid `Surface` string. Narrows an unchecked value. */
export function isSurface(value: unknown): value is Surface {
    return typeof value === 'string' && SURFACE_ORDER.includes(value as Surface);
}

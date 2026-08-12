// Pure. Draw order is fixed, so a UI node can never sort beneath a world node whatever its
// `layer`; `editorOverlay` sits above `ui` so a gizmo stays grabbable over the widget it moves.

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

/** The three surfaces the shared camera transforms. */
const CAMERA_TRANSFORMED: ReadonlySet<Surface> = new Set<Surface>([
    'editorSpace',
    'world',
    'editorOverlay',
]);

/** Editor chrome is excluded so a letterbox bar never cuts off a gizmo or a panel. */
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

/** `true` for a valid `Surface` string. */
export function isSurface(value: unknown): value is Surface {
    return typeof value === 'string' && SURFACE_ORDER.includes(value as Surface);
}

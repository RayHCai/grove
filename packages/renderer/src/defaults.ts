// One copy of each fallback, so the headless backend answers what the real one would.

import type { Size } from '@platform/math';
import type { CameraState } from './renderer.js';

/** The size a texture that is not resident, or an image that declares none, reports. */
export const PLACEHOLDER_SIZE: Readonly<Size> = { width: 1, height: 1 };

/** Font size in px when a style omits `size`: Pixi's own default. */
export const DEFAULT_TEXT_SIZE = 26;

/** A fresh camera at the origin, zoom 1, stage framing; fresh because a caller may keep it. */
export function defaultCamera(): CameraState {
    return { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' };
}

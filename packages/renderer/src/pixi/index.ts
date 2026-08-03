// The PixiJS backend's entry point — `@platform/renderer/pixi`.
//
// A subpath export, so importing `@platform/renderer` for the TYPE never pulls `pixi.js` into the
// module graph (§13). Only this specifier does.

import type { IRenderer } from '../renderer.js';
import { PixiRenderer } from './pixi-renderer.js';

/**
 * A PixiJS v8 `IRenderer`.
 *
 * A factory rather than a class export (§11.1): no inheritance coupling, and a caller holds the
 * interface. `init()` is async because `Application.init()` is.
 */
export function createPixiRenderer(): IRenderer {
    return new PixiRenderer();
}

export { PixiRenderer };

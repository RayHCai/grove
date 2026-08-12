// A subpath export, so importing `@platform/renderer` for the type never pulls `pixi.js` into the
// module graph — only this specifier does.

import type { IRenderer } from '../renderer.js';
import { PixiRenderer } from './pixi-renderer.js';

/** A PixiJS v8 `IRenderer`. `init()` is async because `Application.init()` is. */
export function createPixiRenderer(): IRenderer {
    return new PixiRenderer();
}

export { PixiRenderer };

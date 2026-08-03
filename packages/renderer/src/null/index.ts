// The headless backend's entry point — `@platform/renderer/null`.
//
// A FACTORY, not a class export (§11.1): callers hold the `IRenderer` type, not an inheritance
// relationship. The class is exported too, because the contract suite needs its test-only
// observability members (`isCulled`, `drawOrderOf`) which are deliberately absent from
// `IRenderer`.

import type { IRenderer } from '../renderer.js';
import { NullRenderer } from './null-renderer.js';

/** A headless `IRenderer` — for tests, the server, and CI. No DOM, no GPU. */
export function createNullRenderer(): IRenderer {
    return new NullRenderer();
}

export { NullRenderer };

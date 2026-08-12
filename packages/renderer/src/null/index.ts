// A factory, not a class export, so callers hold the `IRenderer` type rather than an inheritance
// relationship. The class is exported too, for the test-only observability members the contract
// suite needs and `IRenderer` deliberately lacks.

import type { IRenderer } from '../renderer.js';
import { NullRenderer } from './null-renderer.js';

/** A headless `IRenderer` — for tests, the server, and CI. No DOM, no GPU. */
export function createNullRenderer(): IRenderer {
    return new NullRenderer();
}

export { NullRenderer };

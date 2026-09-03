// The browser-safe half: nothing reachable from here may pull tsc or rolldown into a module graph.

export type { ScriptClass, ScriptEntry, ScriptChunkModule, ScriptSide } from './registry.js';
export { ScriptRegistry, locationsFor } from './registry.js';

export type { Redirect } from './policy.js';
export {
    TRANSCENDENTALS,
    DENIED_MATH,
    DENIED_GLOBALS,
    ALIASED_MATH,
    COMPUTED_MATH,
    CONSTRUCTOR_READ,
    DYNAMIC_IMPORT,
} from './policy.js';

export type { ShimOptions, Shim } from './shim.js';
export { installDeterminismShim } from './shim.js';

export type { BundleErrorCode, Diagnostic } from './errors.js';
export { DeterminismError, BundleError, formatDiagnostic } from './errors.js';

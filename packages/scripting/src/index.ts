// @platform/scripting
// The runtime half: the registry a chunk's exports build, the determinism policy both halves read,
// and the shim behind the build's static pass. The toolchain that emits a chunk is `./toolchain`,
// kept off this path so a browser bundle never pulls a compiler or a bundler into its graph.

export const PACKAGE_NAME = '@platform/scripting';

export type { ScriptClass, ScriptEntry, ScriptChunkModule, ScriptSide } from './registry.js';
export { ScriptRegistry, locationsFor } from './registry.js';

export type { Redirect } from './policy.js';
export {
    TRANSCENDENTALS,
    DENIED_MATH,
    DENIED_GLOBALS,
    ALIASED_MATH,
    COMPUTED_MATH,
} from './policy.js';

export type { ShimOptions, Shim } from './shim.js';
export { installDeterminismShim } from './shim.js';

export type { Diagnostic } from './errors.js';
export { DeterminismError, BundleError, formatDiagnostic } from './errors.js';

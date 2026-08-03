// @platform/engine
// Public @platform/engine entry point. Re-exports the creator API.

// Shell package: the public surface lands here.
export const PACKAGE_NAME = '@platform/engine';

// The primitives are IMPLEMENTED in @platform/math and re-exported here, so the
// creator-facing names in api_spec.ts (`Vec3` at :48, `Bounds` at :57, `clamp` at :82,
// `lerp` at :83) each resolve to exactly one type. A creator has one import; the split is
// internal (api_design.md §11.1).
export type { Vec3, Vec3Like, Bounds, Size } from '@platform/math';
export { clamp, lerp } from '@platform/math';

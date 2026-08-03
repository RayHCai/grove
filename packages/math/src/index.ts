// @platform/math
// Pure math: vectors, bounds, easing, scalar helpers, seeded random. No dependencies.

export const PACKAGE_NAME = '@platform/math';

export type { Vec3, Vec3Like } from './vec3.js';
export { vec3, vec3Set, vec3Copy, vec3Z } from './vec3.js';

export type { Bounds, Size } from './bounds.js';
export {
    bounds,
    boundsSet,
    boundsCopy,
    boundsWidth,
    boundsHeight,
    boundsOverlap,
    boundsContains,
    boundsExpand,
    boundsSize,
} from './bounds.js';

export { DEG2RAD, RAD2DEG, clamp, lerp } from './scalar.js';

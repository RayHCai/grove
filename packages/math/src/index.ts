// @platform/math
// Pure math: vectors, bounds, easing, scalar helpers, seeded random, deterministic
// transcendentals. No dependencies.

export const PACKAGE_NAME = '@platform/math';

export type { Vec3, MutableVec3, Vec3Like } from './vec3.js';
export {
    vec3,
    vec3Set,
    vec3Copy,
    vec3Z,
    vec3Length,
    vec3LengthSq,
    vec3Dist,
    vec3Normalize,
} from './vec3.js';

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

export { DEG2RAD, RAD2DEG, clamp, lerp, approach } from './scalar.js';

export type { Easing } from './easing.js';
export { ease } from './easing.js';

export { SeededRandom } from './random.js';

export {
    sin,
    cos,
    tan,
    asin,
    acos,
    atan,
    atan2,
    sinh,
    cosh,
    tanh,
    asinh,
    acosh,
    atanh,
    exp,
    expm1,
    log,
    log1p,
    log2,
    log10,
    pow,
    cbrt,
    hypot,
} from './deterministic-math.js';

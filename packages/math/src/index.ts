// @platform/math
// Pure, dependency-free primitives: vectors, bounds, easing, scalar helpers, seeded random,
// deterministic transcendentals, generation-packed handles, the slot table, typed-array growth.

export type { Vec3, MutableVec3, Vec3Like } from './vec3.js';
export {
    vec3,
    vec3Set,
    vec3Copy,
    vec3Length,
    vec3LengthSq,
    vec3Dist2D,
    vec3Normalize,
} from './vec3.js';

export type { Bounds, Size } from './bounds.js';
export {
    bounds,
    boundsSet,
    boundsCopy,
    boundsWidth,
    boundsHeight,
    boundsEqual,
    boundsOverlap,
    boundsContains,
    boundsExpand,
} from './bounds.js';

export { DEG2RAD, RAD2DEG, clamp, lerp, approach } from './scalar.js';

export { finiteOr, isFiniteNumber, positiveOr } from './numeric.js';

export { defined } from './optional.js';

export {
    INDEX_RANGE,
    MAX_INDEX,
    MAX_GENERATION,
    FIRST_GENERATION,
    packHandle,
    handleIndex,
    handleGeneration,
    nextGeneration,
} from './handle.js';

export type { SlotTableSnapshot } from './slot-table.js';
export { SlotTable } from './slot-table.js';

export { growF64, growI32, growU8, grownCapacity } from './typed-array.js';

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

// `clamp` and `lerp` are on the creator surface too, so this is their one home — the engine
// re-exports rather than reimplements, and each name resolves to one function.

/** Radians per degree. Rotation is authored in degrees everywhere above the backend. */
export const DEG2RAD = Math.PI / 180;

/** Degrees per radian. */
export const RAD2DEG = 180 / Math.PI;

/**
 * Constrains `value` to `[min, max]`.
 *
 * A reversed range is normalized rather than returning `NaN`, so a caller that computed
 * its bounds gets a defined answer.
 */
export function clamp(value: number, min: number, max: number): number {
    const lo = min <= max ? min : max;
    const hi = min <= max ? max : min;
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

/** Linear interpolation. Unclamped: `t` outside 0..1 extrapolates. */
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Moves `current` toward `target` by at most `maxDelta`, the primitive under every acceleration
 * and friction curve. Stops exactly at `target` rather than oscillating past it.
 */
export function approach(current: number, target: number, maxDelta: number): number {
    if (current < target) {
        return Math.min(current + maxDelta, target);
    }
    if (current > target) {
        return Math.max(current - maxDelta, target);
    }
    return target;
}

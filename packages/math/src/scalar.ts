// Scalar helpers. `clamp` and `lerp` are on the creator surface too (api_spec.ts:82-83),
// so this is their one home — the engine re-exports rather than reimplements.

/** Radians per degree. Rotation is authored in degrees everywhere above the backend. */
export const DEG2RAD = Math.PI / 180;

/** Degrees per radian. */
export const RAD2DEG = 180 / Math.PI;

/**
 * Constrains `value` to `[min, max]`. Matches api_spec.ts:82.
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

/** Linear interpolation. Unclamped: `t` outside 0..1 extrapolates. api_spec.ts:83. */
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Frame-rate-independent move-toward-a-number: the primitive under every acceleration
 * and friction curve. Protected on BaseMovement (api_spec.ts:747), tested in math
 * against dt sequences rather than through an avatar.
 *
 * Moves `current` toward `target` by at most `maxDelta`. Stops exactly at `target`
 * rather than oscillating past it.
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

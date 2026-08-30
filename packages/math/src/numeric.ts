/** Narrows an untrusted value to a finite number — a wire `NaN` or `Infinity` is not one. */
export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** `value` when it is finite, else `fallback`. For coordinates, which may be negative. */
export function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

/** `value` when it is finite and positive, else `fallback`. */
export function positiveOr(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

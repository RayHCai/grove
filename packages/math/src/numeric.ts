/** `value` when it is finite, else `fallback`. For coordinates, which may be negative. */
export function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

/** `value` when it is finite and positive, else `fallback`. */
export function positiveOr(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

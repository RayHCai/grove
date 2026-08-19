// Growth for structure-of-arrays storage: reallocate, copy, default the new tail.
//
// The `<ArrayBuffer>` argument is load-bearing: the unparameterized spelling widens to
// `ArrayBufferLike`, which includes `SharedArrayBuffer` and is not assignable back to the fields.

/** Reallocates `src` at `capacity`, defaulting the new tail to `fill`. */
export function growF64(
    src: Float64Array<ArrayBuffer>,
    capacity: number,
    fill = 0,
): Float64Array<ArrayBuffer> {
    const next = new Float64Array(capacity);
    next.set(src);
    // Only the new tail needs the default; `set` has already written everything before it.
    if (fill !== 0) next.fill(fill, src.length);
    return next;
}

/** Reallocates `src` at `capacity`, defaulting the new tail to `fill`. */
export function growI32(
    src: Int32Array<ArrayBuffer>,
    capacity: number,
    fill = 0,
): Int32Array<ArrayBuffer> {
    const next = new Int32Array(capacity);
    next.set(src);
    if (fill !== 0) next.fill(fill, src.length);
    return next;
}

/** Reallocates `src` at `capacity`, defaulting the new tail to `fill`. */
export function growU8(
    src: Uint8Array<ArrayBuffer>,
    capacity: number,
    fill = 0,
): Uint8Array<ArrayBuffer> {
    const next = new Uint8Array(capacity);
    next.set(src);
    if (fill !== 0) next.fill(fill, src.length);
    return next;
}

/** Doubles `current` until it holds `needed`, so growth costs amortized O(1) per slot. */
export function grownCapacity(current: number, needed: number): number {
    // A zero or negative start would never reach `needed` by doubling.
    let capacity = current > 0 ? current : 1;
    while (capacity < needed) capacity *= 2;
    return capacity;
}

// Generation-packed handles: `generation * 2^24 + index`.
//
// Must be arithmetic, never bitwise: `<<` and `|` coerce to int32, so `generation << 24` wraps
// negative at generation 128 and starts minting handles that collide with live ones.

/** Slots per generation. 2^24 = 16,777,216 live slots. */
export const INDEX_RANGE = 0x100_0000;

/** Highest slot index a handle can address. */
export const MAX_INDEX = INDEX_RANGE - 1;

/** Highest generation before a handle would leave the safe-integer range. */
export const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / INDEX_RANGE);

/** Generations start at 1, so a zeroed field is never a valid handle. */
export const FIRST_GENERATION = 1;

/** Packs a slot index and generation into a handle. */
export function packHandle(index: number, generation: number): number {
    return generation * INDEX_RANGE + index;
}

/** The slot index a handle addresses. */
export function handleIndex(handle: number): number {
    return handle % INDEX_RANGE;
}

/** The generation a handle was minted in. */
export function handleGeneration(handle: number): number {
    return Math.floor(handle / INDEX_RANGE);
}

/**
 * The generation a slot moves to when it is freed.
 *
 * Wraps rather than growing without bound: past `MAX_GENERATION` a packed handle leaves the
 * safe-integer range, where distinct handles start comparing equal. `SlotTable` retires a slot
 * rather than mint across the wrap, so the reissued handle is never handed out.
 */
export function nextGeneration(generation: number): number {
    return generation >= MAX_GENERATION ? FIRST_GENERATION : generation + 1;
}

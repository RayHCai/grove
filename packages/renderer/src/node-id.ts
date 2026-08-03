// Packed node handles: `generation * 2^24 + index`.
//
// 16.7M live nodes and 2^26 reuses per slot, all inside Number.MAX_SAFE_INTEGER (§7).
//
// MUST BE ARITHMETIC, NOT BITWISE. JavaScript's `<<` and `|` coerce to int32, so
// `generation << 24` wraps to a negative number at generation 128 and starts handing out
// handles that collide with live ones. Multiply and divide instead. See the named test in
// tests/node-id.test.ts.

/** An opaque handle to a renderer node. Branded so a raw number cannot be passed as one. */
export type NodeId = number & { readonly __nodeId: unique symbol };

/** The null handle. Generations start at 1, so a zeroed field is never a valid node. */
export const NO_NODE = 0 as NodeId;

/** Slots per generation. 2^24 = 16,777,216 live nodes. */
export const INDEX_RANGE = 0x100_0000;

/** Highest slot index a handle can address. */
export const MAX_INDEX = INDEX_RANGE - 1;

/**
 * Highest generation a slot can reach before wrapping, keeping every handle a safe
 * integer: `floor(MAX_SAFE_INTEGER / 2^24)` = 536,870,911.
 */
export const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / INDEX_RANGE);

/**
 * Packs a slot index and generation into a handle.
 *
 * Arithmetic on purpose — see the file header.
 */
export function packNodeId(index: number, generation: number): NodeId {
    return (generation * INDEX_RANGE + index) as NodeId;
}

/** The slot index a handle addresses. */
export function nodeIndex(id: NodeId): number {
    return id % INDEX_RANGE;
}

/** The generation a handle was minted in. */
export function nodeGeneration(id: NodeId): number {
    return Math.floor(id / INDEX_RANGE);
}

// Packed node handles: `generation * 2^24 + index`.
//
// Arithmetic, never bitwise: `generation << 24` coerces to int32 and wraps negative at
// generation 128, handing out handles that collide with live ones.

/** An opaque handle to a renderer node. Branded so a raw number cannot be passed as one. */
export type NodeId = number & { readonly __nodeId: unique symbol };

/** The null handle. Generations start at 1, so a zeroed field is never a valid node. */
export const NO_NODE = 0 as NodeId;

/** Slots per generation. 2^24 = 16,777,216 live nodes. */
export const INDEX_RANGE = 0x100_0000;

/** Highest slot index a handle can address. */
export const MAX_INDEX = INDEX_RANGE - 1;

/** Highest generation a slot can reach and still pack into a safe integer. */
export const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / INDEX_RANGE);

/** Packs a slot index and generation into a handle. */
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

// `NodeId`'s brand over the shared generation-packed handle: the packing, the field sizes and the
// arithmetic-never-bitwise rule all live in `@platform/math`, so the entity and node handles cannot
// drift apart.

import { handleGeneration, handleIndex, packHandle } from '@platform/math';

export { INDEX_RANGE, MAX_INDEX, MAX_GENERATION } from '@platform/math';

/** An opaque handle to a renderer node. Branded so a raw number cannot be passed as one. */
export type NodeId = number & { readonly __nodeId: unique symbol };

/** The null handle. Generations start at 1, so a zeroed field is never a valid node. */
export const NO_NODE = 0 as NodeId;

/** Packs a slot index and generation into a handle. */
export function packNodeId(index: number, generation: number): NodeId {
    return packHandle(index, generation) as NodeId;
}

/** The slot index a handle addresses. */
export function nodeIndex(id: NodeId): number {
    return handleIndex(id);
}

/** The generation a handle was minted in. */
export function nodeGeneration(id: NodeId): number {
    return handleGeneration(id);
}

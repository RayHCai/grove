import { handleGeneration, handleIndex, packHandle } from '@platform/math';

/** An opaque handle to an entity slot. Branded so a raw number cannot pass as one. */
export type EntityId = number & { readonly __entityId: unique symbol };

/** The null handle. Generations start at 1, so a zeroed field is never a valid id. */
export const NO_ENTITY = 0 as EntityId;

export { INDEX_RANGE, MAX_INDEX, MAX_GENERATION } from '@platform/math';

/** Packs a slot index and generation into a handle. */
export function packEntityId(index: number, generation: number): EntityId {
    return packHandle(index, generation) as EntityId;
}

/** The slot index a handle addresses. */
export function entityIndex(id: EntityId): number {
    return handleIndex(id);
}

/** The generation a handle was minted in. */
export function entityGeneration(id: EntityId): number {
    return handleGeneration(id);
}

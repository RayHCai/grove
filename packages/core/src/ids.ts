// Generation-packed entity handles, reusing the renderer's node-id pattern (DESIGN §6):
// `generation * 2^24 + index`. A stale `Entity` reference is a no-op rather than a crash,
// and iteration is by ascending slot, which is creation order — the engine-stable order
// determinism requires (§1.2).
//
// MUST BE ARITHMETIC, NOT BITWISE. JavaScript's `<<`/`|` coerce to int32, so
// `generation << 24` wraps negative at generation 128 and starts minting handles that
// collide with live ones. Multiply and divide instead. See tests/ids.test.ts.

/** An opaque handle to an entity slot. Branded so a raw number cannot pass as one. */
export type EntityId = number & { readonly __entityId: unique symbol };

/** The null handle. Generations start at 1, so a zeroed field is never a valid id. */
export const NO_ENTITY = 0 as EntityId;

/** Slots per generation. 2^24 = 16,777,216 live entities. */
export const INDEX_RANGE = 0x100_0000;

/** Highest slot index a handle can address. */
export const MAX_INDEX = INDEX_RANGE - 1;

/** Highest generation before a handle would leave the safe-integer range. */
export const MAX_GENERATION = Math.floor(Number.MAX_SAFE_INTEGER / INDEX_RANGE);

/** Packs a slot index and generation into a handle. Arithmetic on purpose — see header. */
export function packEntityId(index: number, generation: number): EntityId {
    return (generation * INDEX_RANGE + index) as EntityId;
}

/** The slot index a handle addresses. */
export function entityIndex(id: EntityId): number {
    return id % INDEX_RANGE;
}

/** The generation a handle was minted in. */
export function entityGeneration(id: EntityId): number {
    return Math.floor(id / INDEX_RANGE);
}

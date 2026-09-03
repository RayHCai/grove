// A ring of transform captures roughly MAX_REWIND_MS long, so the server can judge a shot
// against the world the shooter saw. Reads a buffer and marks nothing, so it is invisible to
// replication and to the determinism test. Slots are reused rather than allocated per tick.

import { grownCapacity } from '@platform/math';
import { MAX_REWIND_MS } from '../config.js';
import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
import { Broadphase } from '../world/broadphase.js';
import type { TransformView } from '../world/broadphase.js';
import type { EntityTable } from '../world/entity-table.js';
import type { SimTransformStore } from '../world/transform-store.js';

interface RingSlot {
    tick: number;
    /** Position only: the two lanes `bufferView` reads, indexed by slot like the live store. */
    posX: Float64Array;
    posY: Float64Array;
    /** Who was alive at that tick, generation and all; a transform buffer records neither. */
    ids: EntityId[];
    filled: boolean;
}

export class LagRing {
    readonly #transforms: SimTransformStore;
    readonly #entities: EntityTable;
    readonly #slots: RingSlot[];
    #head = 0;

    constructor(transforms: SimTransformStore, entities: EntityTable, simRate: number) {
        this.#transforms = transforms;
        this.#entities = entities;
        const depth = Math.max(1, Math.ceil((simRate * MAX_REWIND_MS) / 1000));
        this.#slots = Array.from({ length: depth }, () => ({
            tick: -1,
            posX: new Float64Array(0),
            posY: new Float64Array(0),
            ids: [] as EntityId[],
            filled: false,
        }));
    }

    /** Captures the live positions for `tick` into the next ring slot (end of tick). */
    capture(tick: number): void {
        const slot = this.#slots[this.#head]!;
        const cap = this.#transforms.slotCount;
        if (slot.posX.length < cap) {
            // Doubled, not fitted: a slot regrows once per doubling rather than once per entity.
            const grown = grownCapacity(slot.posX.length, cap);
            slot.posX = new Float64Array(grown);
            slot.posY = new Float64Array(grown);
        }
        this.#transforms.copyPositions(slot.posX, slot.posY);
        this.#entities.liveIds(slot.ids);
        slot.tick = tick;
        slot.filled = true;
        this.#head = (this.#head + 1) % this.#slots.length;
    }

    /** The captured tick nearest `tick` within the window, or the latest if none matches. */
    #slotFor(tick: number): RingSlot | undefined {
        let best: RingSlot | undefined;
        for (const slot of this.#slots) {
            if (!slot.filled) continue;
            if (slot.tick === tick) return slot;
            if (!best || Math.abs(slot.tick - tick) < Math.abs(best.tick - tick)) best = slot;
        }
        return best;
    }

    /** A throwaway Broadphase over the capture nearest `viewTick`. */
    broadphaseAt(
        viewTick: number,
        halfExtent: (id: EntityId, axis: 'w' | 'h') => number,
    ): Broadphase | null {
        const slot = this.#slotFor(viewTick);
        if (!slot) return null;
        return new Broadphase(bufferView(slot, halfExtent));
    }

    /** The most recent capture — used when a caller has no specific view tick. */
    broadphaseAtLatest(
        halfExtent: (id: EntityId, axis: 'w' | 'h') => number = () => 0,
    ): Broadphase | null {
        let latest: RingSlot | undefined;
        for (const slot of this.#slots) {
            if (slot.filled && (!latest || slot.tick > latest.tick)) latest = slot;
        }
        return latest ? new Broadphase(bufferView(latest, halfExtent)) : null;
    }

    get depth(): number {
        return this.#slots.length;
    }
}

// The view speaks real EntityIds: a bare slot index reads as (0, 0) against a caller's
// generation-packed id, and still writes through, because the stores address by slot.
function bufferView(
    slot: RingSlot,
    halfExtent: (id: EntityId, axis: 'w' | 'h') => number,
): TransformView {
    const posX = slot.posX;
    const posY = slot.posY;
    const ids = slot.ids;
    return {
        liveIds: (o: EntityId[] = []) => {
            o.length = 0;
            for (const id of ids) o.push(id);
            return o;
        },
        posX: (id) => posX[entityIndex(id)] ?? 0,
        posY: (id) => posY[entityIndex(id)] ?? 0,
        halfWidth: (id) => halfExtent(id, 'w'),
        halfHeight: (id) => halfExtent(id, 'h'),
    };
}

// The server-side lag ring (DESIGN §8.1, api_spec.ts asSeen). The server retains a ring
// of transform captures — roughly MAX_REWIND_MS long — so an authoritative resolution of
// a shot judges it against the world as it stood a send interval ago, not as it stands
// now. A historical query reads a captured buffer and leaves the simulation running: it
// runs no step, sweeps no invocation, marks no channel (§8.1), so it is invisible to the
// determinism test and to replication.
//
// `capture(into)` reuses buffers — the ring is a fixed set refilled in turn, not a
// per-tick allocation. The Broadphase is constructible over a supplied buffer, which is
// what lets a query build a throwaway index without touching the live one.

import { MAX_REWIND_MS } from '../config.js';
import type { EntityId } from '../ids.js';
import { Broadphase } from '../world/broadphase.js';
import type { TransformView } from '../world/broadphase.js';
import type { SimTransformStore, TransformBuffer } from '../world/transform-store.js';

interface RingSlot {
    tick: number;
    buffer: TransformBuffer;
    filled: boolean;
}

export class LagRing {
    readonly #transforms: SimTransformStore;
    readonly #slots: RingSlot[];
    #head = 0;

    constructor(transforms: SimTransformStore, simRate: number) {
        this.#transforms = transforms;
        const depth = Math.max(1, Math.ceil((simRate * MAX_REWIND_MS) / 1000));
        this.#slots = Array.from({ length: depth }, () => ({
            tick: -1,
            buffer: transforms.createBuffer(),
            filled: false,
        }));
    }

    /** Captures the live transforms for `tick` into the next ring slot (end of tick). */
    capture(tick: number): void {
        const slot = this.#slots[this.#head]!;
        this.#transforms.capture(slot.buffer, null);
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

    /** A throwaway Broadphase over the capture nearest `viewTick` (§8.1). */
    broadphaseAt(viewTick: number, halfExtent: (id: EntityId, axis: 'w' | 'h') => number): Broadphase | null {
        const slot = this.#slotFor(viewTick);
        if (!slot) return null;
        return new Broadphase(bufferView(slot.buffer, halfExtent));
    }

    /** The most recent capture — used when a caller has no specific view tick. */
    broadphaseAtLatest(halfExtent: (id: EntityId, axis: 'w' | 'h') => number = () => 0): Broadphase | null {
        let latest: RingSlot | undefined;
        for (const slot of this.#slots) {
            if (slot.filled && (!latest || slot.tick > latest.tick)) latest = slot;
        }
        return latest ? new Broadphase(bufferView(latest.buffer, halfExtent)) : null;
    }

    get depth(): number {
        return this.#slots.length;
    }
}

function bufferView(
    buffer: TransformBuffer,
    halfExtent: (id: EntityId, axis: 'w' | 'h') => number,
): TransformView {
    const ids: EntityId[] = [];
    for (let i = 0; i < buffer.count; i++) {
        // A captured slot holds every slot index; treat a nonzero scale as a live entity.
        if (buffer.scale[i] !== 0) ids.push(i as unknown as EntityId);
    }
    return {
        liveIds: (o: EntityId[] = []) => {
            o.length = 0;
            o.push(...ids);
            return o;
        },
        posX: id => buffer.posX[id as unknown as number] ?? 0,
        posY: id => buffer.posY[id as unknown as number] ?? 0,
        halfWidth: id => halfExtent(id, 'w'),
        halfHeight: id => halfExtent(id, 'h'),
    };
}

// Simulation state only; the renderer keeps its own interpolated transforms and reads this
// store through a sink. Float64 because composed positions accumulate and drift costs more
// than the memory does.

import { growF64, growI32, grownCapacity } from '@platform/math';
import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

const INITIAL_CAPACITY = 64;

export interface TransformBuffer {
    posX: Float64Array<ArrayBuffer>;
    posY: Float64Array<ArrayBuffer>;
    posZ: Float64Array<ArrayBuffer>;
    rot: Float64Array<ArrayBuffer>;
    scale: Float64Array<ArrayBuffer>;
    opacity: Float64Array<ArrayBuffer>;
    layer: Int32Array<ArrayBuffer>;
    count: number;
    /**
     * Slots this buffer holds, or null for the whole `[0, count)` range. A scoped capture must
     * name them: `apply` would otherwise write the untouched slots too, teleporting every
     * out-of-scope entity to the buffer's zeros.
     */
    slots: number[] | null;
}

function createTransformBuffer(capacity = INITIAL_CAPACITY): TransformBuffer {
    return {
        posX: new Float64Array(capacity),
        posY: new Float64Array(capacity),
        posZ: new Float64Array(capacity),
        rot: new Float64Array(capacity),
        scale: new Float64Array(capacity).fill(1),
        opacity: new Float64Array(capacity).fill(1),
        layer: new Int32Array(capacity),
        count: 0,
        slots: null,
    };
}

/** Regrows `into` in place, keeping the caller's reference — a ring slot reuses its buffer. */
function growBuffer(into: TransformBuffer, capacity: number): void {
    into.posX = growF64(into.posX, capacity);
    into.posY = growF64(into.posY, capacity);
    into.posZ = growF64(into.posZ, capacity);
    into.rot = growF64(into.rot, capacity);
    into.scale = growF64(into.scale, capacity, 1);
    into.opacity = growF64(into.opacity, capacity, 1);
    into.layer = growI32(into.layer, capacity);
}

export class SimTransformStore implements SnapshotStore<TransformBuffer> {
    readonly storeName = 'transforms';
    readonly scopeMode: ScopeMode = 'filtered';

    #posX = new Float64Array(INITIAL_CAPACITY);
    #posY = new Float64Array(INITIAL_CAPACITY);
    #posZ = new Float64Array(INITIAL_CAPACITY);
    #rot = new Float64Array(INITIAL_CAPACITY);
    #scale = new Float64Array(INITIAL_CAPACITY).fill(1);
    #opacity = new Float64Array(INITIAL_CAPACITY).fill(1);
    #layer = new Int32Array(INITIAL_CAPACITY);
    #count = 0;

    /** Slot indexes written since the last drain. */
    readonly #dirty = new Set<number>();

    initSlot(id: EntityId): void {
        const index = entityIndex(id);
        this.#ensure(index + 1);
        if (index >= this.#count) this.#count = index + 1;
        this.#posX[index] = 0;
        this.#posY[index] = 0;
        this.#posZ[index] = 0;
        this.#rot[index] = 0;
        this.#scale[index] = 1;
        this.#opacity[index] = 1;
        this.#layer[index] = 0;
    }

    releaseSlot(id: EntityId): void {
        const index = entityIndex(id);
        if (index >= this.#count) return;
        this.#posX[index] = 0;
        this.#posY[index] = 0;
        this.#posZ[index] = 0;
        this.#rot[index] = 0;
        this.#scale[index] = 1;
        this.#opacity[index] = 1;
        this.#layer[index] = 0;
        this.#dirty.delete(index);
    }

    setPosition(id: EntityId, x: number, y: number, z = 0): void {
        const i = entityIndex(id);
        this.#posX[i] = x;
        this.#posY[i] = y;
        this.#posZ[i] = z;
        this.#dirty.add(i);
    }

    setRotation(id: EntityId, degrees: number): void {
        const i = entityIndex(id);
        this.#rot[i] = degrees;
        this.#dirty.add(i);
    }

    setScale(id: EntityId, scale: number): void {
        const i = entityIndex(id);
        this.#scale[i] = scale;
        this.#dirty.add(i);
    }

    setOpacity(id: EntityId, opacity: number): void {
        const i = entityIndex(id);
        this.#opacity[i] = opacity;
        this.#dirty.add(i);
    }

    setLayer(id: EntityId, layer: number): void {
        const i = entityIndex(id);
        this.#layer[i] = layer;
        this.#dirty.add(i);
    }

    posX(id: EntityId): number {
        return this.#posX[entityIndex(id)] ?? 0;
    }
    posY(id: EntityId): number {
        return this.#posY[entityIndex(id)] ?? 0;
    }
    posZ(id: EntityId): number {
        return this.#posZ[entityIndex(id)] ?? 0;
    }
    rotation(id: EntityId): number {
        return this.#rot[entityIndex(id)] ?? 0;
    }
    scale(id: EntityId): number {
        return this.#scale[entityIndex(id)] ?? 1;
    }
    opacity(id: EntityId): number {
        return this.#opacity[entityIndex(id)] ?? 1;
    }
    layer(id: EntityId): number {
        return this.#layer[entityIndex(id)] ?? 0;
    }

    consumeDirty(out: number[] = []): number[] {
        out.length = 0;
        for (const i of this.#dirty) out.push(i);
        this.#dirty.clear();
        return out;
    }

    isDirty(id: EntityId): boolean {
        return this.#dirty.has(entityIndex(id));
    }

    createBuffer(): TransformBuffer {
        return createTransformBuffer(this.#count || INITIAL_CAPACITY);
    }

    /** Slots this store addresses — the high-water index, which never falls, not the live count. */
    get slotCount(): number {
        return this.#count;
    }

    /**
     * Copies the two position lanes into caller-owned arrays and returns the count written.
     *
     * The lag ring's view reads position and nothing else — its half-extents come from the live
     * facade — so a full capture would copy five lanes per tick that no reader ever looks at.
     * The caller sizes the arrays; a short one would silently drop the tail.
     */
    copyPositions(intoX: Float64Array, intoY: Float64Array): number {
        const cap = this.#count;
        intoX.set(this.#posX.subarray(0, cap));
        intoY.set(this.#posY.subarray(0, cap));
        return cap;
    }

    capture(into: TransformBuffer, scope: Scope): void {
        const cap = this.#count;
        // A TypedArray drops an out-of-range write silently, so an undersized buffer would
        // report a count it does not hold and restore stale values for the missing slots.
        // Grown the same way the store grows itself: an exact fit reallocates all seven arrays
        // every time the high-water slot rises by one, which is quadratic over a filling world.
        if (into.posX.length < cap) growBuffer(into, grownCapacity(into.posX.length, cap));
        into.count = cap;

        if (scope === null) {
            into.slots = null;
            into.posX.set(this.#posX.subarray(0, cap));
            into.posY.set(this.#posY.subarray(0, cap));
            into.posZ.set(this.#posZ.subarray(0, cap));
            into.rot.set(this.#rot.subarray(0, cap));
            into.scale.set(this.#scale.subarray(0, cap));
            into.opacity.set(this.#opacity.subarray(0, cap));
            into.layer.set(this.#layer.subarray(0, cap));
            return;
        }

        const slots = into.slots ?? [];
        slots.length = 0;
        for (const id of scope) {
            const i = entityIndex(id);
            if (i >= cap) continue;
            slots.push(i);
            into.posX[i] = this.#posX[i]!;
            into.posY[i] = this.#posY[i]!;
            into.posZ[i] = this.#posZ[i]!;
            into.rot[i] = this.#rot[i]!;
            into.scale[i] = this.#scale[i]!;
            into.opacity[i] = this.#opacity[i]!;
            into.layer[i] = this.#layer[i]!;
        }
        into.slots = slots;
    }

    apply(from: TransformBuffer): void {
        const cap = from.count;
        this.#ensure(cap);
        this.#count = Math.max(this.#count, cap);

        if (from.slots === null) {
            this.#posX.set(from.posX.subarray(0, cap));
            this.#posY.set(from.posY.subarray(0, cap));
            this.#posZ.set(from.posZ.subarray(0, cap));
            this.#rot.set(from.rot.subarray(0, cap));
            this.#scale.set(from.scale.subarray(0, cap));
            this.#opacity.set(from.opacity.subarray(0, cap));
            this.#layer.set(from.layer.subarray(0, cap));
            return;
        }

        for (const i of from.slots) {
            this.#posX[i] = from.posX[i]!;
            this.#posY[i] = from.posY[i]!;
            this.#posZ[i] = from.posZ[i]!;
            this.#rot[i] = from.rot[i]!;
            this.#scale[i] = from.scale[i]!;
            this.#opacity[i] = from.opacity[i]!;
            this.#layer[i] = from.layer[i]!;
        }
    }

    #ensure(needed: number): void {
        if (needed <= this.#posX.length) return;
        const cap = grownCapacity(this.#posX.length, needed);
        this.#posX = growF64(this.#posX, cap);
        this.#posY = growF64(this.#posY, cap);
        this.#posZ = growF64(this.#posZ, cap);
        this.#rot = growF64(this.#rot, cap);
        this.#scale = growF64(this.#scale, cap, 1);
        this.#opacity = growF64(this.#opacity, cap, 1);
        this.#layer = growI32(this.#layer, cap);
    }
}

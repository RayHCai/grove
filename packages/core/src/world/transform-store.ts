// The simulation transform store. Structure-of-arrays over the entity id's slot index.
// Separate from the renderer's transform store: this holds SIMULATION state (positions
// from movement, setPosition, tweens) while the renderer holds PRESENTATION state
// (interpolated, with anchor/tint/alpha layered on). The renderer reads from here via
// the SceneSink seam (DESIGN §5.1).
//
// Float64Array for the same reason as the renderer: composed positions accumulate, and
// at world-pixel magnitudes the memory difference is irrelevant while drift is not.

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
    };
}

function growF64(src: Float64Array<ArrayBuffer>, cap: number, fill = 0): Float64Array<ArrayBuffer> {
    const next = new Float64Array(cap);
    next.set(src);
    if (fill !== 0) next.fill(fill, src.length);
    return next;
}

function growI32(src: Int32Array<ArrayBuffer>, cap: number): Int32Array<ArrayBuffer> {
    const next = new Int32Array(cap);
    next.set(src);
    return next;
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

    /** Bitset: which entities changed since the last drain (§5.1 transform channel). */
    readonly #dirty = new Set<number>();

    get slotCount(): number {
        return this.#count;
    }

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

    // ─── writes ─────────────────────────────────────────────────────────────────

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

    // ─── reads ──────────────────────────────────────────────────────────────────

    posX(id: EntityId): number { return this.#posX[entityIndex(id)] ?? 0; }
    posY(id: EntityId): number { return this.#posY[entityIndex(id)] ?? 0; }
    posZ(id: EntityId): number { return this.#posZ[entityIndex(id)] ?? 0; }
    rotation(id: EntityId): number { return this.#rot[entityIndex(id)] ?? 0; }
    scale(id: EntityId): number { return this.#scale[entityIndex(id)] ?? 1; }
    opacity(id: EntityId): number { return this.#opacity[entityIndex(id)] ?? 1; }
    layer(id: EntityId): number { return this.#layer[entityIndex(id)] ?? 0; }

    // ─── dirty set (§5.1 transform channel) ─────────────────────────────────────

    consumeDirty(out: number[] = []): number[] {
        out.length = 0;
        for (const i of this.#dirty) out.push(i);
        this.#dirty.clear();
        return out;
    }

    isDirty(id: EntityId): boolean {
        return this.#dirty.has(entityIndex(id));
    }

    // ─── snapshot/restore (§8.1) ────────────────────────────────────────────────

    createBuffer(): TransformBuffer {
        return createTransformBuffer(this.#count || INITIAL_CAPACITY);
    }

    capture(into: TransformBuffer, scope: Scope): void {
        if (scope === null) {
            const cap = this.#count;
            if (into.posX.length < cap) {
                Object.assign(into, createTransformBuffer(cap));
            }
            into.posX.set(this.#posX.subarray(0, cap));
            into.posY.set(this.#posY.subarray(0, cap));
            into.posZ.set(this.#posZ.subarray(0, cap));
            into.rot.set(this.#rot.subarray(0, cap));
            into.scale.set(this.#scale.subarray(0, cap));
            into.opacity.set(this.#opacity.subarray(0, cap));
            into.layer.set(this.#layer.subarray(0, cap));
            into.count = cap;
        } else {
            into.count = this.#count;
            for (const id of scope) {
                const i = entityIndex(id);
                if (i >= this.#count) continue;
                into.posX[i] = this.#posX[i]!;
                into.posY[i] = this.#posY[i]!;
                into.posZ[i] = this.#posZ[i]!;
                into.rot[i] = this.#rot[i]!;
                into.scale[i] = this.#scale[i]!;
                into.opacity[i] = this.#opacity[i]!;
                into.layer[i] = this.#layer[i]!;
            }
        }
    }

    apply(from: TransformBuffer): void {
        const cap = from.count;
        this.#ensure(cap);
        this.#count = Math.max(this.#count, cap);
        this.#posX.set(from.posX.subarray(0, cap));
        this.#posY.set(from.posY.subarray(0, cap));
        this.#posZ.set(from.posZ.subarray(0, cap));
        this.#rot.set(from.rot.subarray(0, cap));
        this.#scale.set(from.scale.subarray(0, cap));
        this.#opacity.set(from.opacity.subarray(0, cap));
        this.#layer.set(from.layer.subarray(0, cap));
    }

    // ─── internals ──────────────────────────────────────────────────────────────

    #ensure(needed: number): void {
        if (needed <= this.#posX.length) return;
        let cap = this.#posX.length;
        while (cap < needed) cap *= 2;
        this.#posX = growF64(this.#posX, cap);
        this.#posY = growF64(this.#posY, cap);
        this.#posZ = growF64(this.#posZ, cap);
        this.#rot = growF64(this.#rot, cap);
        this.#scale = growF64(this.#scale, cap, 1);
        this.#opacity = growF64(this.#opacity, cap, 1);
        this.#layer = growI32(this.#layer, cap);
    }
}

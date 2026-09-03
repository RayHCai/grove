// isTrigger decides whether a body was stopped, not whether it touches, so both kinds count here.

import { grownCapacity } from '@platform/math';
import type { EntityId } from '../ids.js';
import { NO_ENTITY } from '../ids.js';
import { Broadphase } from '../world/broadphase.js';
import type { TransformView } from '../world/broadphase.js';
import type { Runtime } from './runtime.js';
import type { Entity } from './entity.js';
import { liveTransformView } from './transform-view.js';

export class ContactSource {
    readonly #rt: Runtime;
    readonly #view: TransformView;
    readonly #live: Broadphase;
    readonly #ids: EntityId[] = [];
    readonly #overlapping: Array<[EntityId, EntityId]> = [];
    /**
     * The pairs that overlapped on the previous tick.
     *
     * `@onCollide` is the moment two bodies touch, not a per-tick predicate — `getTouching` is the
     * pull-based "am I still on the plate" — so the pass needs a previous tick to diff against. It
     * lives here, on what owns the pair walk, and is deliberately not a snapshot store: a rewind
     * leaves it describing the tick it was last folded on, which is why the client drops the pass.
     */
    #previous = new Set<string>();
    #current = new Set<string>();
    /** Per-body lanes for the pair walk, indexed by position in `#ids`, not by slot. */
    #posX = new Float64Array(0);
    #posY = new Float64Array(0);
    #halfW = new Float64Array(0);
    #halfH = new Float64Array(0);
    #parent = new Float64Array(0);
    readonly #halfExtent = (id: EntityId, axis: 'w' | 'h'): number =>
        halfExtent(this.#rt, id, axis);

    constructor(rt: Runtime) {
        this.#rt = rt;
        this.#view = liveTransformView(rt, this.#halfExtent);
        this.#live = new Broadphase(this.#view);
    }

    /** Entities overlapping `id` this tick, optionally filtered by tag. */
    touching(id: EntityId, tag: string | undefined, asSeen: boolean): Entity[] {
        if (!this.#rt.entityManager.facade(id).collider) {
            return [];
        }
        const bp = asSeen ? this.#historicalBroadphase() : this.#live;
        const hits = bp.overlapping(id);
        const rec = this.#rt.entities.record(id);
        const out: Entity[] = [];
        for (const other of hits) {
            if (this.#isSelfOrKin(id, other, rec?.parent)) continue;
            if (tag !== undefined && !this.#rt.tags.has(other, tag)) continue;
            out.push(this.#rt.entityManager.facade(other));
        }
        return out;
    }

    /** Overlapping pairs for this tick's @onCollide dispatch. */
    pairs(out: Array<[EntityId, EntityId]> = []): Array<[EntityId, EntityId]> {
        out.length = 0;
        const ids = this.#rt.entities.liveIds(this.#ids);
        const n = ids.length;
        if (n < 2) return out;
        // Read each body's transform, extents and parent once into flat arrays, then compare
        // out of those: every read here is a closure hop into a facade lookup and a bounds
        // division, and the walk below would otherwise pay four of them per candidate pair.
        this.#loadScratch(ids, n);

        const posX = this.#posX;
        const posY = this.#posY;
        const halfW = this.#halfW;
        const halfH = this.#halfH;
        const parent = this.#parent;

        for (let i = 0; i < n; i++) {
            const a = ids[i]!;
            const ax = posX[i]!;
            const ay = posY[i]!;
            const aw = halfW[i]!;
            const ah = halfH[i]!;
            const aParent = parent[i]!;
            for (let j = i + 1; j < n; j++) {
                const b = ids[j]!;
                const bParent = parent[j]!;
                if (aParent === b || bParent === a) continue;
                if (!(Math.abs(ax - posX[j]!) <= aw + halfW[j]!)) continue;
                if (!(Math.abs(ay - posY[j]!) <= ah + halfH[j]!)) continue;
                out.push([a, b]);
            }
        }
        return out;
    }

    /** Fills the per-body scratch lanes for `ids`, growing them if this world outgrew the last. */
    #loadScratch(ids: readonly EntityId[], n: number): void {
        if (this.#posX.length < n) {
            const cap = grownCapacity(this.#posX.length, n);
            this.#posX = new Float64Array(cap);
            this.#posY = new Float64Array(cap);
            this.#halfW = new Float64Array(cap);
            this.#halfH = new Float64Array(cap);
            this.#parent = new Float64Array(cap);
        }
        const view = this.#view;
        const entities = this.#rt.entities;
        for (let i = 0; i < n; i++) {
            const id = ids[i]!;
            this.#posX[i] = view.posX(id);
            this.#posY[i] = view.posY(id);
            this.#halfW[i] = view.halfWidth(id);
            this.#halfH[i] = view.halfHeight(id);
            this.#parent[i] = entities.record(id)?.parent ?? NO_ENTITY;
        }
    }

    /** The pairs that began overlapping this tick, and the fold that makes the next call an edge again. */
    entered(out: Array<[EntityId, EntityId]> = []): Array<[EntityId, EntityId]> {
        out.length = 0;
        this.#current.clear();
        for (const pair of this.pairs(this.#overlapping)) {
            // `liveIds()` is ascending slot order, so one pair always reaches this in one order and
            // the key identifies it across ticks; a reused slot carries a new generation and so a new key.
            const key = `${pair[0] as number}:${pair[1] as number}`;
            this.#current.add(key);
            if (!this.#previous.has(key)) out.push(pair);
        }
        const spent = this.#previous;
        this.#previous = this.#current;
        spent.clear();
        this.#current = spent;
        return out;
    }

    #isSelfOrKin(id: EntityId, other: EntityId, parent: EntityId | undefined): boolean {
        if (id === other) return true;
        if (parent !== undefined && parent === other) return true;
        const otherRec = this.#rt.entities.record(other);
        return otherRec?.parent === id;
    }

    /** Reads a past capture and marks nothing, so an `asSeen` query is invisible to replication. */
    #historicalBroadphase(): Broadphase {
        return this.#rt.wired.lagRing.broadphaseAtLatest(this.#halfExtent) ?? this.#live;
    }
}

function halfExtent(rt: Runtime, id: EntityId, axis: 'w' | 'h'): number {
    const collider = rt.entityManager.facade(id).collider;
    if (!collider) return 0;
    const b = collider.bounds;
    return axis === 'w' ? Math.abs(b.right - b.left) / 2 : Math.abs(b.top - b.bottom) / 2;
}

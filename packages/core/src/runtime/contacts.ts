// isTrigger decides whether a body was stopped, not whether it touches, so both kinds count here.

import type { EntityId } from '../ids.js';
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
        // Both arrays are reused: this is O(n²) per tick, so allocating inside the loops put a
        // view object and five closures per candidate pair on the GC.
        const ids = this.#rt.entities.liveIds(this.#ids);
        for (let i = 0; i < ids.length; i++) {
            const a = ids[i]!;
            const parent = this.#rt.entities.record(a)?.parent;
            for (let j = i + 1; j < ids.length; j++) {
                const b = ids[j]!;
                if (this.#isSelfOrKin(a, b, parent)) continue;
                if (this.#overlaps(a, b)) out.push([a, b]);
            }
        }
        return out;
    }

    #isSelfOrKin(id: EntityId, other: EntityId, parent: EntityId | undefined): boolean {
        if (id === other) return true;
        if (parent !== undefined && parent === other) return true;
        const otherRec = this.#rt.entities.record(other);
        return otherRec?.parent === id;
    }

    #overlaps(a: EntityId, b: EntityId): boolean {
        const view = this.#view;
        return (
            Math.abs(view.posX(a) - view.posX(b)) <= view.halfWidth(a) + view.halfWidth(b) &&
            Math.abs(view.posY(a) - view.posY(b)) <= view.halfHeight(a) + view.halfHeight(b)
        );
    }

    /** Reads a past capture and marks nothing, so an `asSeen` query is invisible to replication. */
    #historicalBroadphase(): Broadphase {
        return this.#rt.lagRing?.broadphaseAtLatest(this.#halfExtent) ?? this.#live;
    }
}

function halfExtent(rt: Runtime, id: EntityId, axis: 'w' | 'h'): number {
    const collider = rt.entityManager.facade(id).collider;
    if (!collider) return 0;
    const b = collider.bounds;
    return axis === 'w' ? Math.abs(b.right - b.left) / 2 : Math.abs(b.top - b.bottom) / 2;
}

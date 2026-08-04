// The ContactSource over the Broadphase (DESIGN §2, §5.4). getTouching / isTouching /
// @onCollide / @onEnter / @onExit run against it. Cost is O(n²) per tick, no rotation, no
// sub-AABB shapes — the one place core computes geometry it will later delegate. Both
// collider kinds count; isTrigger decides whether you were stopped, not whether touching.
// Excludes self and own parent/children; engine-stable order (ascending id).
//
// asSeen resolves against a captured past frame via a throwaway Broadphase over a ring
// buffer (§8.1) — reads the past, never writes the present.

import type { EntityId } from '../ids.js';
import { Broadphase } from '../world/broadphase.js';
import type { TransformView } from '../world/broadphase.js';
import type { Runtime } from './runtime.js';
import type { Entity } from './entity.js';

export class ContactSource {
    readonly #rt: Runtime;
    readonly #live: Broadphase;

    constructor(rt: Runtime) {
        this.#rt = rt;
        this.#live = new Broadphase(this.#viewOverLive());
    }

    /** Entities overlapping `id` this tick, optionally filtered by tag (§5.4 semantics). */
    touching(id: EntityId, tag: string | undefined, asSeen: boolean): Entity[] {
        if (!this.#rt.entityManager.facade(id).collider) {
            return []; // no collider means an empty array, never null (§5.4)
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

    /** Pairs overlapping this tick, for the tick's @onCollide dispatch (loop step 5). */
    pairs(out: Array<[EntityId, EntityId]> = []): Array<[EntityId, EntityId]> {
        out.length = 0;
        const ids = this.#rt.entities.liveIds();
        for (let i = 0; i < ids.length; i++) {
            const a = ids[i]!;
            for (let j = i + 1; j < ids.length; j++) {
                const b = ids[j]!;
                if (this.#isSelfOrKin(a, b, this.#rt.entities.record(a)?.parent)) continue;
                if (this.#overlaps(a, b)) out.push([a, b]);
            }
        }
        return out;
    }

    #isSelfOrKin(id: EntityId, other: EntityId, parent: EntityId | undefined): boolean {
        if (id === other) return true;
        if (parent !== undefined && parent === other) return true;
        const otherRec = this.#rt.entities.record(other);
        return otherRec?.parent === id; // other is my child
    }

    #overlaps(a: EntityId, b: EntityId): boolean {
        const view = this.#viewOverLive();
        return (
            Math.abs(view.posX(a) - view.posX(b)) <= view.halfWidth(a) + view.halfWidth(b) &&
            Math.abs(view.posY(a) - view.posY(b)) <= view.halfHeight(a) + view.halfHeight(b)
        );
    }

    #viewOverLive(): TransformView {
        const rt = this.#rt;
        return {
            liveIds: (o?: EntityId[]) => rt.entities.liveIds(o),
            posX: id => rt.transforms.posX(id),
            posY: id => rt.transforms.posY(id),
            halfWidth: id => halfExtent(rt, id, 'w'),
            halfHeight: id => halfExtent(rt, id, 'h'),
        };
    }

    /** A throwaway index over the most recent ring capture (§8.1), or the live one if empty. */
    #historicalBroadphase(): Broadphase {
        return (
            this.#rt.lagRing?.broadphaseAtLatest((id, axis) => halfExtent(this.#rt, id, axis)) ?? this.#live
        );
    }
}

function halfExtent(rt: Runtime, id: EntityId, axis: 'w' | 'h'): number {
    const collider = rt.entityManager.facade(id).collider;
    if (!collider) return 0;
    const b = collider.bounds;
    return axis === 'w' ? Math.abs(b.right - b.left) / 2 : Math.abs(b.top - b.bottom) / 2;
}

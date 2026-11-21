// isTrigger decides whether a body was stopped, not whether it touches, so both kinds count here.

import type { EntityId } from '../ids.js';
import { Broadphase } from '../world/broadphase.js';
import type { Runtime } from './runtime.js';
import type { Entity } from './entity.js';
import { liveTransformView } from './transform-view.js';

export class ContactSource {
    readonly #rt: Runtime;
    readonly #live: Broadphase;
    readonly #overlapping: Array<[EntityId, EntityId]> = [];
    /** The pairs that overlapped on the previous tick, so the pass can diff. Not snapshotted. */
    #previous = new Set<string>();
    #current = new Set<string>();
    readonly #halfExtent = (id: EntityId, axis: 'w' | 'h'): number =>
        halfExtent(this.#rt, id, axis);
    // A body without a collider touches nothing, so it never enters the walk at all.
    readonly #isBody = (id: EntityId): boolean => hasCollider(this.#rt, id);
    readonly #isKin = (a: EntityId, b: EntityId): boolean => {
        const entities = this.#rt.entities;
        return entities.record(a)?.parent === b || entities.record(b)?.parent === a;
    };

    constructor(rt: Runtime) {
        this.#rt = rt;
        this.#live = new Broadphase(liveTransformView(rt, this.#halfExtent, this.#isBody));
    }

    /** Entities overlapping `id` this tick, optionally filtered by tag. */
    touching(id: EntityId, tag: string | undefined, asSeen: boolean): Entity[] {
        if (!this.#isBody(id)) return [];
        const bp = asSeen ? this.#historicalBroadphase() : this.#live;
        const hits = bp.overlapping(id);
        const rec = this.#rt.entities.record(id);
        const out: Entity[] = [];
        for (const other of hits) {
            if (this.#isSelfOrKin(id, other, rec?.parent)) continue;
            // The ring lists every entity it captured, so a historical hit is checked here too.
            if (!this.#isBody(other)) continue;
            if (tag !== undefined && !this.#rt.tags.has(other, tag)) continue;
            out.push(this.#rt.entityManager.facade(other));
        }
        return out;
    }

    /** Overlapping pairs of collider-bearing bodies for this tick's @onCollide dispatch. */
    pairs(out: Array<[EntityId, EntityId]> = []): Array<[EntityId, EntityId]> {
        return this.#live.pairs(out, this.#isKin);
    }

    /** The pairs that began overlapping this tick, plus the fold keeping the next call an edge. */
    entered(out: Array<[EntityId, EntityId]> = []): Array<[EntityId, EntityId]> {
        out.length = 0;
        this.#current.clear();
        for (const pair of this.pairs(this.#overlapping)) {
            // `liveIds()` is ascending slot order, so one pair always reaches this in one order and
            // the key identifies it across ticks; a reused slot carries a new generation and so a
            // new key.
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

function hasCollider(rt: Runtime, id: EntityId): boolean {
    return Boolean(rt.entityManager.facade(id).collider);
}

function halfExtent(rt: Runtime, id: EntityId, axis: 'w' | 'h'): number {
    const collider = rt.entityManager.facade(id).collider;
    if (!collider) return 0;
    const b = collider.bounds;
    return axis === 'w' ? Math.abs(b.right - b.left) / 2 : Math.abs(b.top - b.bottom) / 2;
}

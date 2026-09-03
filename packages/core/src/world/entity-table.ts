// Iteration is by ascending slot — creation order, the stable order determinism needs.
// SimTransformStore addresses entities by the same slot index, so a reused slot is the same
// entity in both stores.

import { SlotTable } from '@platform/math';
import type { EntityId } from '../ids.js';
import { NO_ENTITY } from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

const NONE = NO_ENTITY;

/** Per-entity data outside the transform SoA. */
export interface EntityRecord {
    template: string;
    /** The owning player's id, or '' for an unowned body. */
    ownerId: string;
    parent: EntityId;
    children: EntityId[];
    alive: boolean;
    /** Set by destroy(); the slot is released in the tick's destroy drain. */
    destroyPending: boolean;
}

export interface EntityTableBuffer {
    records: (EntityRecord | null)[];
    generations: number[];
    freeList: number[];
    live: number;
}

function cloneRecord(r: EntityRecord): EntityRecord {
    return {
        template: r.template,
        ownerId: r.ownerId,
        parent: r.parent,
        children: [...r.children],
        alive: r.alive,
        destroyPending: r.destroyPending,
    };
}

export class EntityTable implements SnapshotStore<EntityTableBuffer> {
    readonly storeName = 'entities';
    // Whole, not filtered: a scoped subset would still need every slot's generation, or a handle
    // the scope excluded would stop reading as stale.
    readonly scopeMode: ScopeMode = 'whole';

    readonly #slots = new SlotTable<EntityId, EntityRecord>('EntityTable');

    create(template = '', ownerId = ''): EntityId {
        return this.#slots.create({
            template,
            ownerId,
            parent: NONE,
            children: [],
            alive: true,
            destroyPending: false,
        });
    }

    /** The slot index, or -1 for the null / a stale / an out-of-range handle. Never throws. */
    indexOf(id: EntityId): number {
        return this.#slots.indexOf(id);
    }

    /** The record's own flag, not slot occupancy: destroy() clears it a tick before the release. */
    isAlive(id: EntityId): boolean {
        return this.#slots.record(id)?.alive ?? false;
    }

    exists(id: EntityId): boolean {
        return this.#slots.exists(id);
    }

    record(id: EntityId): EntityRecord | null {
        return this.#slots.record(id);
    }

    idAt(index: number): EntityId {
        return this.#slots.idAt(index);
    }

    /** Frees the slot and bumps the generation, so handles minted for it stay stale. */
    release(id: EntityId): void {
        this.#slots.release(id);
    }

    /** How many slots are occupied — what the spawn cap is read against, without building a list. */
    get liveCount(): number {
        return this.#slots.liveCount;
    }

    /** Live entity ids in ascending slot order — creation order. */
    liveIds(out: EntityId[] = []): EntityId[] {
        return this.#slots.liveIds(out);
    }

    clear(): void {
        this.#slots.clear();
    }

    createBuffer(): EntityTableBuffer {
        return { records: [], generations: [], freeList: [], live: 0 };
    }

    capture(into: EntityTableBuffer, _scope: Scope): void {
        // Cloned even out of scope: handing back the live record object would make the snapshot
        // track every later mutation of it.
        this.#slots.captureInto(into, cloneRecord);
    }

    apply(from: EntityTableBuffer): void {
        this.#slots.apply(from, cloneRecord);
    }
}

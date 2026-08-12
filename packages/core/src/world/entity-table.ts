// Iteration is by ascending slot — creation order, the stable order determinism needs.
// SimTransformStore addresses entities by the same slot index, so a reused slot is the same
// entity in both stores.

import type { EntityId } from '../ids.js';
import {
    MAX_GENERATION,
    MAX_INDEX,
    NO_ENTITY,
    entityGeneration,
    entityIndex,
    packEntityId,
} from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

const FIRST_GENERATION = 1;
const NONE = NO_ENTITY;

function nextGeneration(generation: number): number {
    return generation >= MAX_GENERATION ? FIRST_GENERATION : generation + 1;
}

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
    readonly scopeMode: ScopeMode = 'filtered';

    #records: (EntityRecord | null)[] = [];
    #generations: number[] = [];
    #freeList: number[] = [];
    #live = 0;

    get liveCount(): number {
        return this.#live;
    }

    get slotCount(): number {
        return this.#records.length;
    }

    create(template = '', ownerId = ''): EntityId {
        const record: EntityRecord = {
            template,
            ownerId,
            parent: NONE,
            children: [],
            alive: true,
            destroyPending: false,
        };
        const reused = this.#freeList.pop();
        if (reused === undefined) {
            const index = this.#records.length;
            if (index > MAX_INDEX) {
                throw new RangeError(`EntityTable is full: all ${MAX_INDEX + 1} slots are live`);
            }
            this.#records.push(record);
            this.#generations.push(FIRST_GENERATION);
            this.#live++;
            return packEntityId(index, FIRST_GENERATION);
        }
        const generation = this.#generations[reused] ?? FIRST_GENERATION;
        this.#records[reused] = record;
        this.#live++;
        return packEntityId(reused, generation);
    }

    /** The slot index, or -1 for the null / a stale / an out-of-range handle. Never throws. */
    indexOf(id: EntityId): number {
        if (id <= 0 || !Number.isSafeInteger(id)) return -1;
        const index = entityIndex(id);
        if (this.#records[index] == null) return -1;
        return this.#generations[index] === entityGeneration(id) ? index : -1;
    }

    isAlive(id: EntityId): boolean {
        const index = this.indexOf(id);
        return index >= 0 && this.#records[index]!.alive;
    }

    exists(id: EntityId): boolean {
        return this.indexOf(id) >= 0;
    }

    record(id: EntityId): EntityRecord | null {
        const index = this.indexOf(id);
        return index >= 0 ? this.#records[index]! : null;
    }

    idAt(index: number): EntityId {
        if (this.#records[index] == null) return NONE;
        const generation = this.#generations[index] ?? FIRST_GENERATION;
        return packEntityId(index, generation);
    }

    /** Frees the slot and bumps the generation, so handles minted for it stay stale. */
    release(id: EntityId): void {
        const index = this.indexOf(id);
        if (index < 0) return;
        this.#records[index] = null;
        this.#generations[index] = nextGeneration(this.#generations[index] ?? FIRST_GENERATION);
        this.#freeList.push(index);
        this.#live--;
    }

    /** Live entity ids in ascending slot order — creation order. */
    liveIds(out: EntityId[] = []): EntityId[] {
        out.length = 0;
        for (let index = 0; index < this.#records.length; index++) {
            if (this.#records[index] != null) out.push(this.idAt(index));
        }
        return out;
    }

    clear(): void {
        for (let index = 0; index < this.#records.length; index++) {
            if (this.#records[index] == null) continue;
            this.#records[index] = null;
            this.#generations[index] = nextGeneration(this.#generations[index] ?? FIRST_GENERATION);
            this.#live--;
        }
        this.#freeList.length = 0;
        for (let index = this.#records.length - 1; index >= 0; index--) {
            this.#freeList.push(index);
        }
    }

    createBuffer(): EntityTableBuffer {
        return { records: [], generations: [], freeList: [], live: 0 };
    }

    capture(into: EntityTableBuffer, scope: Scope): void {
        into.generations = [...this.#generations];
        into.freeList = [...this.#freeList];
        into.live = this.#live;
        if (scope === null) {
            into.records = this.#records.map((r) => (r ? cloneRecord(r) : null));
        } else {
            // Cloned even out of scope: handing back the live object would make the snapshot
            // track every later mutation of it.
            into.records = this.#records.map((r) => (r ? cloneRecord(r) : null));
        }
    }

    apply(from: EntityTableBuffer): void {
        this.#records = from.records.map((r) => (r ? cloneRecord(r) : null));
        this.#generations = [...from.generations];
        this.#freeList = [...from.freeList];
        this.#live = from.live;
    }
}

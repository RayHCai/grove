// Every store holding simulation state registers here, because a hand-written snapshot list
// forgets one store and desyncs a playtest. `scopeMode` has deliberately no default: a store
// that never declares how it narrows is caught by the coverage test.

import type { EntityId } from '../ids.js';

/** How a store narrows under a scoped snapshot: by entity id, entire, or rebuilt on apply. */
export type ScopeMode = 'filtered' | 'whole' | 'derived';

/** The entities a scoped snapshot covers; `null` is the unscoped whole-world form. */
export type Scope = ReadonlySet<EntityId> | null;

/** A store that participates in snapshot/restore. */
export interface SnapshotStore<T = unknown> {
    readonly storeName: string;

    readonly scopeMode: ScopeMode;

    createBuffer(): T;

    /** Refills a caller-owned buffer, because a scoped capture runs every client frame. */
    capture(into: T, scope: Scope): void;

    apply(from: T): void;
}

interface CapturedEntry {
    store: SnapshotStore;
    buffer: unknown;
}

export interface Snapshot {
    readonly tick: number;
    readonly scope: Scope;
    readonly entries: readonly CapturedEntry[];
}

/** The registry the runtime holds; registration order is capture and apply order. */
export class StoreRegistry {
    readonly #stores: SnapshotStore[] = [];
    readonly #names = new Set<string>();

    /** Registers a store; a duplicate name is a wiring bug, so it throws. */
    register<T>(store: SnapshotStore<T>): void {
        if (this.#names.has(store.storeName)) {
            throw new Error(`store "${store.storeName}" is already registered`);
        }
        this.#names.add(store.storeName);
        this.#stores.push(store as SnapshotStore);
    }

    /** Every registered store, in registration order. */
    get stores(): readonly SnapshotStore[] {
        return this.#stores;
    }

    /** Captures every store at `tick`; a derived store captures nothing and rebuilds on apply. */
    snapshot(tick: number, scope: Scope): Snapshot {
        const entries: CapturedEntry[] = [];
        for (const store of this.#stores) {
            const buffer = store.createBuffer();
            store.capture(buffer, scope);
            entries.push({ store, buffer });
        }
        return { tick, scope, entries };
    }

    /** Restores every store in the order it was captured. */
    restore(snapshot: Snapshot): void {
        for (const { store, buffer } of snapshot.entries) {
            store.apply(buffer);
        }
    }
}

// Snapshot completeness is a registry, not a discipline (DESIGN §8.1).
//
// A hand-written snapshot list is the worst failure mode this design has: forget one store
// and a rare playtest desync follows. So every store that holds simulation state registers
// here and exposes capture/apply, `snapshot()` iterates the registry, and a coverage test
// fails when a store is added without registering — or without declaring HOW it scopes,
// which is how the PRNG was nearly missed (§8.1). There is deliberately NO default mode.

import type { EntityId } from '../ids.js';

/**
 * How a store narrows under a scoped snapshot (DESIGN §8.1).
 *
 *   filtered — entity-keyed; capture only ids in scope (SoA transforms, tag index)
 *   whole    — small or not entity-keyed; captured entire (id allocator, the PRNG)
 *   derived  — rebuilt from other stores on apply, so captured as nothing (Broadphase)
 */
export type ScopeMode = 'filtered' | 'whole' | 'derived';

/**
 * The set of entities a scoped snapshot covers — the predicted set on the client's hot path
 * (DESIGN §8.1). `null` means the unscoped whole-world form used by the harness and tests.
 */
export type Scope = ReadonlySet<EntityId> | null;

/**
 * A store that participates in snapshot/restore.
 *
 * `capture` takes an out-param and refills it, matching the renderer's style: the scoped
 * snapshot runs every client frame, so a fresh object graph per store per frame is GC
 * pressure during exactly the gameplay that made the rewind necessary (§8.1). A reconciler
 * holds one buffer per store and refills it.
 */
export interface SnapshotStore<T = unknown> {
    /** Stable identity, for the coverage test's diagnostics. */
    readonly storeName: string;

    /** Declared with no default — the coverage test asserts every store names one (§8.1). */
    readonly scopeMode: ScopeMode;

    /** A fresh capture buffer this store can refill. */
    createBuffer(): T;

    /** Captures state into `into`. Honors `scope` per the store's `scopeMode`. */
    capture(into: T, scope: Scope): void;

    /** Restores from a buffer produced by `capture`. */
    apply(from: T): void;
}

/** A captured store, paired with the store that can restore it. */
interface CapturedEntry {
    store: SnapshotStore;
    buffer: unknown;
}

/** One snapshot: an ordered list of captured store buffers plus the scope it was taken at. */
export interface Snapshot {
    readonly tick: number;
    readonly scope: Scope;
    readonly entries: readonly CapturedEntry[];
}

/**
 * The registry the runtime holds. Registration order is capture/apply order; derived stores
 * are applied last so the stores they rebuild from are already restored.
 */
export class StoreRegistry {
    readonly #stores: SnapshotStore[] = [];
    readonly #names = new Set<string>();

    /** Registers a store. A duplicate name is a wiring bug, so it throws (§8.1). */
    register<T>(store: SnapshotStore<T>): void {
        if (this.#names.has(store.storeName)) {
            throw new Error(`store "${store.storeName}" is already registered`);
        }
        this.#names.add(store.storeName);
        this.#stores.push(store as SnapshotStore);
    }

    /** Every registered store, in registration order. The coverage test reads this. */
    get stores(): readonly SnapshotStore[] {
        return this.#stores;
    }

    /**
     * Captures every store at `tick`, scoped by `scope`. Derived stores capture nothing;
     * their `apply` rebuilds from the already-restored stores.
     */
    snapshot(tick: number, scope: Scope): Snapshot {
        const entries: CapturedEntry[] = [];
        for (const store of this.#stores) {
            const buffer = store.createBuffer();
            store.capture(buffer, scope);
            entries.push({ store, buffer });
        }
        return { tick, scope, entries };
    }

    /** Restores every store from a snapshot, in the order they were captured. */
    restore(snapshot: Snapshot): void {
        for (const { store, buffer } of snapshot.entries) {
            store.apply(buffer);
        }
    }
}

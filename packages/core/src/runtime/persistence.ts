// `@serverState` that outlives a session, over the `KVStore` seam.
//
// The seam is async and every reader of it is not: wiring hoists a host's fields synchronously, in
// the middle of a join a socket is waiting on, and `@onPlayerLeave` runs on a connection that is
// already gone. So the cache in front of the store is the thing that is read and written, and the
// store is written THROUGH — a saved host is readable while its write is in flight, and that trip is a
// promise the caller may await or route the failure of, but never has to hold a boundary open for.

import type { HostRecord } from '../state/host-record.js';
import { serializeHostField } from './wrappers.js';
import type { KVStore } from './seams.js';

/** The one KV scope persisted host records live under, so nothing else collides with them. */
export const PERSISTENCE_SCOPE = 'serverState';

/** What wiring consults when it seeds a field. Synchronous, because the hoist is. */
export interface PersistedSource {
    get(hostId: string, field: string): unknown;
}

/** One host's persisted fields, as a single KV value — the unit a save and a load both move. */
export type PersistedFields = { [field: string]: unknown };

/**
 * A synchronous view of persisted `@serverState`, write-through to a `KVStore`.
 *
 * Keyed by host id, which is what `rt.persisted` is asked about, and holds whole records rather than
 * fields: a host is saved and loaded as one KV entry, so a rejoin costs one round trip instead of
 * one per declared field.
 */
export class PersistedState implements PersistedSource {
    readonly #kv: KVStore;
    readonly #byHost = new Map<string, PersistedFields>();

    constructor(kv: KVStore) {
        this.#kv = kv;
    }

    get(hostId: string, field: string): unknown {
        return this.#byHost.get(hostId)?.[field];
    }

    /** Whether anything is held for `hostId` — a load that found nothing still counts as held. */
    has(hostId: string): boolean {
        return this.#byHost.has(hostId);
    }

    /** Reads `hostId` out of the store into the cache, so a later synchronous `get` can see it. */
    async load(hostId: string): Promise<void> {
        const stored = await this.#kv.get(PERSISTENCE_SCOPE, hostId);
        // Anything but a plain object is another writer's value or a corrupted one; an empty record
        // is cached either way, so a second load does not re-ask the store for the same nothing.
        this.#byHost.set(hostId, isFields(stored) ? { ...stored } : {});
    }

    /**
     * Captures `record` into the cache now, writes it through to the store, and releases it there.
     *
     * Synchronous capture is what makes leave-then-rejoin work inside one process: the record is
     * torn down the moment the player leaves, so a save that only started an async read of it would
     * be reading a host that no longer exists by the time the promise ran.
     */
    save(record: HostRecord): Promise<void> {
        const fields: PersistedFields = {};
        for (const field of record.values.keys()) {
            const value = serializeHostField(record, field);
            // `undefined` is not a value a store can hold or a codec can express, and a field with
            // nothing in it is indistinguishable from one that was never declared.
            if (value !== undefined) fields[field] = value;
        }
        this.#byHost.set(record.hostId, fields);
        return this.#kv.set(PERSISTENCE_SCOPE, record.hostId, fields).then(() => {
            // Released once the write has landed, and only if it is still this call's record: a
            // save is a host winding down, so keeping it would size the cache by every player the
            // session ever saw rather than by the ones in it.
            if (this.#byHost.get(record.hostId) === fields) this.#byHost.delete(record.hostId);
        });
    }

    /** Drops a host from the store and the cache — the creator-facing "forget this player". */
    forget(hostId: string): Promise<void> {
        this.#byHost.delete(hostId);
        return this.#kv.delete(PERSISTENCE_SCOPE, hostId);
    }
}

function isFields(value: unknown): value is PersistedFields {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

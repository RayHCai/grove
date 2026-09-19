// The seam is async and every reader of it is not, so the cache in front is what is read and
// written, and the store is written THROUGH.

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

/** A synchronous view of persisted `@serverState`, write-through to a `KVStore`, keyed by host. */
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

    /** Captures `record` now, writes through, releases it; sync capture survives a leave. */
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

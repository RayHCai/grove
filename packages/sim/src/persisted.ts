// Core's `PersistedSource` is synchronous and the sim has no store: a load is asked for in one
// output batch and answered in a later input batch, so this is the cache they meet in.

import type { HostRecord } from '@platform/core';
import { serializeHostField } from '@platform/core';
import type { JsonValue } from '@platform/transport';
import type { SaveOrder } from './batch.js';
import { encodeStateValue } from './replicate.js';

/**
 * Host records the sim has been handed, by host id — what `rt.persisted` answers from.
 * Core's `PersistedSource` is satisfied structurally: the barrel exports the class, not the type.
 */
export class SessionRecords {
    readonly #byHost = new Map<string, { [field: string]: unknown }>();

    get(hostId: string, field: string): unknown {
        return this.#byHost.get(hostId)?.[field];
    }

    /** Whether anything is held for `hostId` — a load that found nothing still counts as held. */
    has(hostId: string): boolean {
        return this.#byHost.has(hostId);
    }

    /** Files the host's answer to a load, so the hoist that follows can read it synchronously. */
    seed(hostId: string, fields: { [field: string]: JsonValue }): void {
        this.#byHost.set(hostId, { ...fields });
    }

    /**
     * Captures a departing host's fields as the write the host owes the store. Synchronous, since
     * the record is torn down at the leave; the fields stay cached until `release`.
     */
    capture(record: HostRecord): SaveOrder {
        const fields: { [field: string]: JsonValue } = {};
        for (const field of record.values.keys()) {
            // Through the same encoder the wire uses, so a value the store keeps is one a rejoin's
            // snapshot can carry back.
            const value = encodeStateValue(serializeHostField(record, field));
            if (value !== undefined) fields[field] = value;
        }
        this.#byHost.set(record.hostId, fields);
        return { hostKey: record.hostId, fields };
    }

    /** Drops a host the store confirmed, so a session is sized by its players, not its history. */
    release(hostId: string): void {
        this.#byHost.delete(hostId);
    }
}

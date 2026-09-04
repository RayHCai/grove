// The `@serverState` cache the sim reads, filled by the host rather than by a store.
//
// Core's `PersistedSource` is synchronous because the hoist that reads it is, and the sim has no
// store to be asynchronous against: a load is asked for in one output batch and answered in a later
// input batch, so what is left here is the cache the two halves meet in.

import type { HostRecord } from '@platform/core';
import { serializeHostField } from '@platform/core';
import type { JsonValue } from '@platform/transport';
import type { SaveOrder } from './batch.js';
import { encodeStateValue } from './replicate.js';

/**
 * Host records the sim has been handed, keyed by host id — what `rt.persisted` answers from.
 *
 * Core's `PersistedSource` is satisfied structurally rather than implemented by name: the barrel
 * exports the class over that seam and not the interface, and this is the second implementation.
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
     * Captures a departing host's fields as the write the host owes the store.
     *
     * Captured synchronously because the record is torn down the moment the player leaves — a save
     * that only started an async read of it would find a host that no longer exists. The fields stay
     * cached until {@link SessionRecords.release}, so a rejoin inside this session reads them back
     * whether or not the store write has landed.
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

    /** Drops a host the store has confirmed, so a long session is sized by its players rather than by its history. */
    release(hostId: string): void {
        this.#byHost.delete(hostId);
    }
}

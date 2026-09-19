// Each runtime mints handles from its own table, so one logical entity holds different ids per
// side; the client joins mid-session and does not control the arrival order it is told about.

import type { EntityId } from '@platform/core';
import type { NetId } from '@platform/protocol';

/** Bidirectional, and the only minting authority for the mirror's entities. */
export class MirrorIndex {
    readonly #toLocal = new Map<NetId, EntityId>();
    readonly #toNet = new Map<EntityId, NetId>();

    /** Binds a server identity to a freshly spawned local one, overwriting a stale pairing. */
    set(netId: NetId, local: EntityId): void {
        const previous = this.#toLocal.get(netId);
        if (previous !== undefined) this.#toNet.delete(previous);
        this.#toLocal.set(netId, local);
        this.#toNet.set(local, netId);
    }

    /** The local handle for a server identity, or `undefined` if the mirror does not hold it. */
    local(netId: NetId): EntityId | undefined {
        return this.#toLocal.get(netId);
    }

    /** The server identity for a local handle — what an entity's state host key is built from. */
    net(local: EntityId): NetId | undefined {
        return this.#toNet.get(local);
    }

    has(netId: NetId): boolean {
        return this.#toLocal.has(netId);
    }

    /** Drops both directions. Called after the entity's teardown has drained. */
    delete(netId: NetId): void {
        const local = this.#toLocal.get(netId);
        if (local === undefined) return;
        this.#toLocal.delete(netId);
        this.#toNet.delete(local);
    }

    get size(): number {
        return this.#toLocal.size;
    }

    entries(): IterableIterator<[NetId, EntityId]> {
        return this.#toLocal.entries();
    }

    clear(): void {
        this.#toLocal.clear();
        this.#toNet.clear();
    }
}

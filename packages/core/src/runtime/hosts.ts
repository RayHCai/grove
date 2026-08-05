// The host table ties the four things a host owns together under one key: its scope-tree
// id (for cancellation and timer/tween ownership, §4.3), its host record (@serverState
// values, §5.1), and its attached script instances (§5). A host key is 'game', a player
// id, an entity id, a camera id, or a screen name.

import type { ScopeId } from '../dispatch/scope-tree.js';
import type { HostRecord } from '../state/host-record.js';
import { createHostRecord } from '../state/host-record.js';
import type { ScopeTree } from '../dispatch/scope-tree.js';

export interface HostEntry {
    readonly key: string;
    readonly scopeId: ScopeId;
    readonly record: HostRecord;
}

export class HostTable {
    readonly #scopes: ScopeTree;
    readonly #byKey = new Map<string, HostEntry>();

    constructor(scopes: ScopeTree) {
        this.#scopes = scopes;
    }

    /** Registers a host, creating its scope and record. Idempotent per key. */
    ensure(key: string): HostEntry {
        let entry = this.#byKey.get(key);
        if (!entry) {
            entry = {
                key,
                scopeId: this.#scopes.createHostScope(),
                record: createHostRecord(key),
            };
            this.#byKey.set(key, entry);
        }
        return entry;
    }

    get(key: string): HostEntry | undefined {
        return this.#byKey.get(key);
    }

    scopeId(key: string): ScopeId {
        return this.#byKey.get(key)?.scopeId ?? -1;
    }

    /** Tears a host down: destroys its scope and drops the entry. */
    remove(key: string): void {
        const entry = this.#byKey.get(key);
        if (!entry) return;
        this.#scopes.destroyHostScope(entry.scopeId);
        this.#byKey.delete(key);
    }

    /** The entity id → host scope map the entity manager needs for cascade teardown. */
    scopeForEntity(id: number): ScopeId {
        return this.scopeId(`entity:${id}`);
    }

    clear(): void {
        this.#byKey.clear();
    }
}

export function entityKey(id: number): string {
    return `entity:${id}`;
}

export function playerKey(id: string): string {
    return `player:${id}`;
}

export const GAME_KEY = 'game';

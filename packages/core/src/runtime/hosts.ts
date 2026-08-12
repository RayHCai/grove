// One key per host ties its cancellation scope to its @serverState record.

import type { ScopeId } from '../dispatch/scope-tree.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';
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
    readonly #byScope = new Map<ScopeId, string>();

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
            this.#byScope.set(entry.scopeId, key);
        }
        return entry;
    }

    get(key: string): HostEntry | undefined {
        return this.#byKey.get(key);
    }

    /** The host's scope, or NO_SCOPE when nothing is registered under `key`. */
    scopeId(key: string): ScopeId {
        return this.#byKey.get(key)?.scopeId ?? NO_SCOPE;
    }

    /** The key owning `scopeId`, or undefined — the reverse lookup a scoped capture needs. */
    keyForScope(scopeId: ScopeId): string | undefined {
        return this.#byScope.get(scopeId);
    }

    /** Drops the entry and destroys its scope, cancelling everything the host owned. */
    remove(key: string): void {
        const entry = this.#byKey.get(key);
        if (!entry) return;
        this.#scopes.destroyHostScope(entry.scopeId);
        this.#byKey.delete(key);
        this.#byScope.delete(entry.scopeId);
    }

    scopeForEntity(id: number): ScopeId {
        return this.scopeId(`entity:${id}`);
    }

    clear(): void {
        this.#byKey.clear();
        this.#byScope.clear();
    }
}

export const ENTITY_KEY_PREFIX = 'entity:';

export function entityKey(id: number): string {
    return `${ENTITY_KEY_PREFIX}${id}`;
}

export function playerKey(id: string): string {
    return `player:${id}`;
}

export const GAME_KEY = 'game';

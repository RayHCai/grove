// A per-(instance, method) throw count decides whether a handler runs, so it is simulation
// state and registers with the snapshot — an unrestored counter makes a replay diverge from
// the original run.

import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export interface BreakerBuffer {
    counts: Array<[string, number]>;
}

export class BreakerCounters implements SnapshotStore<BreakerBuffer> {
    readonly storeName = 'breaker';
    // Whole, not filtered: counts are keyed by instance id, which no scope of entity ids narrows.
    readonly scopeMode: ScopeMode = 'whole';

    readonly #counts = new Map<string, number>();

    #key(instanceId: number, method: string): string {
        return `${instanceId}#${method}`;
    }

    recordThrow(instanceId: number, method: string): number {
        const key = this.#key(instanceId, method);
        const next = (this.#counts.get(key) ?? 0) + 1;
        this.#counts.set(key, next);
        return next;
    }

    recordSuccess(instanceId: number, method: string): void {
        this.#counts.delete(this.#key(instanceId, method));
    }

    count(instanceId: number, method: string): number {
        return this.#counts.get(this.#key(instanceId, method)) ?? 0;
    }

    clear(): void {
        this.#counts.clear();
    }

    createBuffer(): BreakerBuffer {
        return { counts: [] };
    }

    // Keys are instance ids, which a scope of entity ids cannot filter, so capture takes all.
    capture(into: BreakerBuffer, _scope: Scope): void {
        into.counts = [...this.#counts.entries()];
    }

    apply(from: BreakerBuffer): void {
        this.#counts.clear();
        for (const [k, v] of from.counts) this.#counts.set(k, v);
    }
}

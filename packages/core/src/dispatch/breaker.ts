// The error boundary's circuit breaker (DESIGN §4.4). A per-(instance, method) throw
// count decides whether a handler runs, so it IS simulation state and registers with the
// snapshot — an unrestored counter means a replay hits a different count than the original
// run. The counter increments on throws and nothing else; any success resets it.
//
// The dedup map is deliberately NOT snapshot state: it affects only console output.

import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export interface BreakerBuffer {
    counts: Array<[string, number]>;
}

export class BreakerCounters implements SnapshotStore<BreakerBuffer> {
    readonly storeName = 'breaker';
    readonly scopeMode: ScopeMode = 'filtered';

    /** key = `${instanceId}#${method}` → consecutive throw count. */
    readonly #counts = new Map<string, number>();

    #key(instanceId: number, method: string): string {
        return `${instanceId}#${method}`;
    }

    /** Records a throw; returns the new consecutive count. */
    recordThrow(instanceId: number, method: string): number {
        const key = this.#key(instanceId, method);
        const next = (this.#counts.get(key) ?? 0) + 1;
        this.#counts.set(key, next);
        return next;
    }

    /** A successful invocation resets the counter (§4.4). */
    recordSuccess(instanceId: number, method: string): void {
        this.#counts.delete(this.#key(instanceId, method));
    }

    count(instanceId: number, method: string): number {
        return this.#counts.get(this.#key(instanceId, method)) ?? 0;
    }

    clear(): void {
        this.#counts.clear();
    }

    // ─── snapshot/restore ────────────────────────────────────────────────────────
    // Scope is by instance-owning host; here we capture whole because instance ids are
    // not entity ids. The runtime's scoped snapshot maps hosts→instances before this.

    createBuffer(): BreakerBuffer {
        return { counts: [] };
    }

    capture(into: BreakerBuffer, _scope: Scope): void {
        into.counts = [...this.#counts.entries()];
    }

    apply(from: BreakerBuffer): void {
        this.#counts.clear();
        for (const [k, v] of from.counts) this.#counts.set(k, v);
    }
}

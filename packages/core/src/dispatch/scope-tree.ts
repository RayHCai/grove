// Three-level scope tree: runtime → host → invocation (DESIGN §4.3).
// Destroying a host cancels its invocations; `restart` cancels one; every engine
// awaitable registers with the innermost live scope.

export type ScopeId = number;

let nextId = 1;

export interface InvocationScope {
    readonly id: ScopeId;
    readonly hostId: ScopeId;
    readonly startTick: number;
    dead: boolean;
    concurrencyKey: string;
    cancel: (() => void) | null;
}

export class ScopeTree {
    readonly #hostScopes = new Map<ScopeId, Set<InvocationScope>>();
    readonly #invocations = new Map<ScopeId, InvocationScope>();

    createHostScope(): ScopeId {
        const id = nextId++;
        this.#hostScopes.set(id, new Set());
        return id;
    }

    destroyHostScope(hostId: ScopeId): void {
        const invocations = this.#hostScopes.get(hostId);
        if (!invocations) return;
        for (const inv of invocations) {
            inv.dead = true;
            inv.cancel?.();
            this.#invocations.delete(inv.id);
        }
        this.#hostScopes.delete(hostId);
    }

    createInvocation(hostId: ScopeId, tick: number, concurrencyKey: string): InvocationScope {
        const scope: InvocationScope = {
            id: nextId++,
            hostId,
            startTick: tick,
            dead: false,
            concurrencyKey,
            cancel: null,
        };
        this.#hostScopes.get(hostId)?.add(scope);
        this.#invocations.set(scope.id, scope);
        return scope;
    }

    cancelInvocation(scope: InvocationScope): void {
        if (scope.dead) return;
        scope.dead = true;
        scope.cancel?.();
        this.#hostScopes.get(scope.hostId)?.delete(scope);
        this.#invocations.delete(scope.id);
    }

    completeInvocation(scope: InvocationScope): void {
        if (scope.dead) return;
        scope.dead = true;
        this.#hostScopes.get(scope.hostId)?.delete(scope);
        this.#invocations.delete(scope.id);
    }

    /** Sweep all invocations newer than `tick` — the parked-invocation rewind (§8.1). */
    sweepAfterTick(tick: number): void {
        for (const [, scope] of this.#invocations) {
            if (scope.startTick > tick) {
                this.cancelInvocation(scope);
            }
        }
    }

    /** Find a running invocation for a (host, concurrencyKey) pair. */
    findRunning(hostId: ScopeId, concurrencyKey: string): InvocationScope | undefined {
        const invocations = this.#hostScopes.get(hostId);
        if (!invocations) return undefined;
        for (const inv of invocations) {
            if (!inv.dead && inv.concurrencyKey === concurrencyKey) return inv;
        }
        return undefined;
    }

    invocationsForHost(hostId: ScopeId): ReadonlySet<InvocationScope> {
        return this.#hostScopes.get(hostId) ?? EMPTY;
    }

    clear(): void {
        for (const [, invocations] of this.#hostScopes) {
            for (const inv of invocations) {
                inv.dead = true;
                inv.cancel?.();
            }
        }
        this.#hostScopes.clear();
        this.#invocations.clear();
    }
}

const EMPTY: ReadonlySet<InvocationScope> = new Set();

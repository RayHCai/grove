// Runtime → host → invocation, so destroying a host cancels every invocation under it.

export type ScopeId = number;

/**
 * The scope of nothing. Ids start at 1, so this can never name a live host — which matters because
 * a miss sentinel that callers also pass as an owner would let one host's teardown cancel every
 * hostless timer in the world.
 */
export const NO_SCOPE: ScopeId = 0;

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

    /** Cancels invocations started after `tick`, so a rewound timeline's parked ones die. */
    sweepAfterTick(tick: number): void {
        for (const [, scope] of this.#invocations) {
            if (scope.startTick > tick) {
                this.cancelInvocation(scope);
            }
        }
    }

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

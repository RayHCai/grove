// The dispatcher (DESIGN §4). Synchronous to the first await: `send` invokes every
// matching handler, each runs to its first `await` before `send` returns, and the
// returned promise settles once all finish (§5.8). Concurrency is per instance (§4.2);
// `restart` cancels the running invocation at its next await point. A throw is caught at
// the invocation boundary, logged, deduplicated, and counted toward the breaker (§4.4).

import { BREAKER_THRESHOLD, MAX_SEND_DEPTH } from '../config.js';
import type { HandlerDecl, HandlerKind, ScriptLocation } from '../script/index.js';
import { defaultConcurrency } from '../script/index.js';
import type { HandlerErrorRecord } from '../errors.js';
import { setCurrentInvocation, resumeWith } from './ambient.js';
import type { ScopeTree } from './scope-tree.js';
import type { BreakerCounters } from './breaker.js';
import type { ScriptInstance } from './instances.js';

/** The event-specific context a handler receives (matches runtime Ctx). */
export interface DispatchCtx {
    player?: unknown;
    other?: unknown;
    value?: number;
    dt: number;
    alive: boolean;
    data: Readonly<Record<string, unknown>>;
    from?: unknown;
    viewTick?: number;
}

export interface DispatchLog {
    error(record: HandlerErrorRecord & { phase?: string; disabled?: boolean }): void;
}

/** Maps a HandlerKind + event to the internal event name a handler declares against. */
function matches(decl: HandlerDecl, kind: HandlerKind, event: string): boolean {
    if (decl.kind !== kind) return false;
    // Lifecycle/pointer kinds ignore the event arg; named kinds must match.
    switch (kind) {
        case 'onEvent':
        case 'onCollide':
        case 'onEnter':
        case 'onExit':
        case 'onPress':
        case 'onRequest':
            return decl.event === event;
        default:
            return true;
    }
}

export interface DispatchOptions {
    /** Which locations run on this machine. Server: server+synced; client: client+synced. */
    activeLocations: ReadonlySet<ScriptLocation>;
    /** Suppress dispatch to client-located handlers on a replay tick (§8.1). */
    replay?: boolean;
    /** The current tick, for the error log and invocation stamp. */
    tick: number;
}

export class Dispatcher {
    readonly #scopes: ScopeTree;
    readonly #breaker: BreakerCounters;
    readonly #log: DispatchLog;
    #depth = 0;

    /** Dedup: `class#method#message` → count. Not snapshot state (§4.4). */
    readonly #dedup = new Map<string, number>();

    constructor(scopes: ScopeTree, breaker: BreakerCounters, log: DispatchLog) {
        this.#scopes = scopes;
        this.#breaker = breaker;
        this.#log = log;
    }

    /**
     * Fires `kind`/`event` at every matching handler on `instances`, in attachment order.
     * Returns a promise settling once all handlers finish (§5.8). Runs synchronously up to
     * each handler's first await before returning.
     */
    dispatch(
        instances: readonly ScriptInstance[],
        kind: HandlerKind,
        event: string,
        hostId: string,
        ctx: DispatchCtx,
        opts: DispatchOptions,
    ): Promise<void> {
        if (this.#depth >= MAX_SEND_DEPTH) {
            this.#log.error({
                scriptClass: '(engine)',
                method: 'dispatch',
                hostId,
                tick: opts.tick,
                event,
                stack: `send recursion exceeded depth ${MAX_SEND_DEPTH}`,
            });
            return Promise.resolve();
        }

        const pending: Promise<void>[] = [];
        this.#depth++;
        try {
            for (const si of instances) {
                if (!opts.activeLocations.has(si.location)) continue;
                if (opts.replay && si.location === 'client') continue; // §8.1 one-shot suppression

                for (const decl of si.handlers) {
                    if (!matches(decl, kind, event)) continue;
                    const p = this.#invoke(si, decl, ctx, opts.tick);
                    if (p) pending.push(p);
                }
            }
        } finally {
            this.#depth--;
        }

        return pending.length === 0 ? Promise.resolve() : Promise.all(pending).then(() => undefined);
    }

    /** Runs one handler under its concurrency mode. Returns its settle promise, or null. */
    #invoke(
        si: ScriptInstance,
        decl: HandlerDecl,
        ctx: DispatchCtx,
        tick: number,
    ): Promise<void> | null {
        const method = decl.methodName;
        const concurrency = decl.opts.concurrency ?? defaultConcurrency(decl.kind);
        const key = `${si.id}#${method}`;

        // Breaker: a handler disabled after ~100 consecutive throws does not run (§4.4).
        if (this.#breaker.count(si.id, method) >= BREAKER_THRESHOLD) return null;

        const running = this.#scopes.findRunning(si.hostScopeId, key);
        if (running) {
            if (concurrency === 'ignore') return null;
            if (concurrency === 'restart') this.#scopes.cancelInvocation(running);
            // concurrent: fall through and start another
        }

        const scope = this.#scopes.createInvocation(si.hostScopeId, tick, key);
        const fn = (si.instance as Record<string, (c: DispatchCtx) => unknown>)[method];
        if (typeof fn !== 'function') {
            this.#scopes.completeInvocation(scope);
            return null;
        }

        setCurrentInvocation(scope);
        let result: unknown;
        try {
            result = fn.call(si.instance, ctx);
            this.#breaker.recordSuccess(si.id, method);
        } catch (err) {
            this.#recordThrow(si, method, tick, decl.event, err);
            this.#scopes.completeInvocation(scope);
            setCurrentInvocation(null);
            return null;
        }
        setCurrentInvocation(null);

        if (!(result instanceof Promise)) {
            this.#scopes.completeInvocation(scope);
            return null;
        }

        // Async handler: settle the scope when its promise resolves, catching a late throw.
        return resumeWith(scope, result as Promise<unknown>).then(
            () => {
                if (!scope.dead) this.#scopes.completeInvocation(scope);
            },
            (err: unknown) => {
                if (!scope.dead) {
                    this.#recordThrow(si, method, tick, decl.event, err);
                    this.#scopes.completeInvocation(scope);
                }
            },
        );
    }

    #recordThrow(si: ScriptInstance, method: string, tick: number, event: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? message) : message;
        const dedupKey = `${si.className}#${method}#${message}`;
        const count = (this.#dedup.get(dedupKey) ?? 0) + 1;
        this.#dedup.set(dedupKey, count);

        this.#log.error({
            scriptClass: si.className,
            method,
            hostId: '',
            tick,
            event,
            stack,
        });

        const consecutive = this.#breaker.recordThrow(si.id, method);
        if (consecutive === BREAKER_THRESHOLD) {
            this.#log.error({
                scriptClass: si.className,
                method,
                hostId: '',
                tick,
                event,
                stack: `handler disabled after ${BREAKER_THRESHOLD} consecutive throws`,
                disabled: true,
            });
        }
    }

    /** Clears dedup state — a new session, not a rewind (dedup is not snapshot state). */
    clearDedup(): void {
        this.#dedup.clear();
    }
}

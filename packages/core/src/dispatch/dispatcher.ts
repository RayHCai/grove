// Synchronous to the first await: every matching handler runs to its first `await` before
// `dispatch` returns, and the promise it returns settles once they all finish.

import { BREAKER_THRESHOLD, MAX_DEDUP_KEYS, MAX_SEND_DEPTH } from '../config.js';
import type { EventPhase, HandlerDecl, HandlerKind, ScriptLocation } from '../script/index.js';
import { defaultConcurrency } from '../script/index.js';
import type { HandlerErrorRecord } from '../errors.js';
import { currentInvocation, setCurrentInvocation, resumeWith } from './ambient.js';
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

function matches(
    decl: HandlerDecl,
    kind: HandlerKind,
    event: string,
    phase: EventPhase | undefined,
): boolean {
    if (decl.kind !== kind) return false;
    switch (kind) {
        case 'onEvent':
            if (decl.event !== event) return false;
            // An unphased dispatch matches every declaration: Entity.send names no edge, so
            // filtering on one would silently drop handlers.
            return phase === undefined || (decl.opts.on ?? 'press') === phase;
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
    /** Suppress dispatch to client-located handlers on a replay tick. */
    replay?: boolean;
    /** The current tick, for the error log and invocation stamp. */
    tick: number;
    /** Which edge an `onEvent` dispatch carries; without it press/release/hold are one event. */
    phase?: EventPhase;
}

export class Dispatcher {
    readonly #scopes: ScopeTree;
    readonly #breaker: BreakerCounters;
    readonly #log: DispatchLog;
    #depth = 0;

    /** Counts `class#method#message`. Nothing reads it yet, so no throw is actually suppressed. */
    readonly #dedup = new Map<string, number>();

    constructor(scopes: ScopeTree, breaker: BreakerCounters, log: DispatchLog) {
        this.#scopes = scopes;
        this.#breaker = breaker;
        this.#log = log;
    }

    /** Fires `kind`/`event` at every matching handler on `instances`, in attachment order. */
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
                if (opts.replay && si.location === 'client') continue;

                for (const decl of si.handlers) {
                    if (!matches(decl, kind, event, opts.phase)) continue;
                    const p = this.#invoke(si, decl, ctx, hostId, opts.tick);
                    if (p) pending.push(p);
                }
            }
        } finally {
            this.#depth--;
        }

        return pending.length === 0
            ? Promise.resolve()
            : Promise.all(pending).then(() => undefined);
    }

    #invoke(
        si: ScriptInstance,
        decl: HandlerDecl,
        ctx: DispatchCtx,
        hostId: string,
        tick: number,
    ): Promise<void> | null {
        const method = decl.methodName;
        const concurrency = decl.opts.concurrency ?? defaultConcurrency(decl.kind);
        const key = `${si.id}#${method}`;

        if (this.#breaker.count(si.id, method) >= BREAKER_THRESHOLD) return null;

        const running = this.#scopes.findRunning(si.hostScopeId, key);
        if (running) {
            if (concurrency === 'ignore') return null;
            if (concurrency === 'restart') this.#scopes.cancelInvocation(running);
            // 'concurrent' has no branch on purpose: it starts a second invocation.
        }

        const scope = this.#scopes.createInvocation(si.hostScopeId, tick, key);
        const fn = (si.instance as Record<string, (c: DispatchCtx) => unknown>)[method];
        if (typeof fn !== 'function') {
            this.#scopes.completeInvocation(scope);
            return null;
        }

        // Restored, not cleared: a nested synchronous send would otherwise return the outer handler
        // to its own body with no invocation, orphaning any timer it starts next.
        const outer = currentInvocation();
        setCurrentInvocation(scope);
        let result: unknown;
        try {
            result = fn.call(si.instance, ctx);
        } catch (err) {
            this.#recordThrow(si, method, hostId, tick, decl.event, err);
            this.#scopes.completeInvocation(scope);
            setCurrentInvocation(outer);
            return null;
        }
        setCurrentInvocation(outer);

        if (!(result instanceof Promise)) {
            this.#breaker.recordSuccess(si.id, method);
            this.#scopes.completeInvocation(scope);
            return null;
        }

        // Only once the promise settles: recording success when the call returns — at the first
        // await — resets the count before the rejection arrives, so the breaker never trips.
        return resumeWith(scope, result as Promise<unknown>).then(
            () => {
                this.#breaker.recordSuccess(si.id, method);
                if (!scope.dead) this.#scopes.completeInvocation(scope);
            },
            (err: unknown) => {
                if (!scope.dead) {
                    this.#recordThrow(si, method, hostId, tick, decl.event, err);
                    this.#scopes.completeInvocation(scope);
                }
            },
        );
    }

    #recordThrow(
        si: ScriptInstance,
        method: string,
        hostId: string,
        tick: number,
        event: string,
        err: unknown,
    ): void {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? message) : message;
        const dedupKey = `${si.className}#${method}#${message}`;
        const seen = (this.#dedup.get(dedupKey) ?? 0) + 1;
        // Bounded: a handler throwing with a fresh message each tick would otherwise grow this map
        // for the life of the process, and it exists only to keep the log readable.
        if (this.#dedup.size >= MAX_DEDUP_KEYS && seen === 1) this.#dedup.clear();
        this.#dedup.set(dedupKey, seen);

        // One record per distinct class#method#message; the repeats are counted, not logged.
        if (seen === 1) {
            this.#log.error({ scriptClass: si.className, method, hostId, tick, event, stack });
        }

        const consecutive = this.#breaker.recordThrow(si.id, method);
        if (consecutive === BREAKER_THRESHOLD) {
            this.#log.error({
                scriptClass: si.className,
                method,
                hostId,
                tick,
                event,
                stack: `handler disabled after ${BREAKER_THRESHOLD} consecutive throws`,
                disabled: true,
            });
        }
    }

    /** How many times `class#method#message` has thrown, including the suppressed repeats. */
    throwCount(scriptClass: string, method: string, message: string): number {
        return this.#dedup.get(`${scriptClass}#${method}#${message}`) ?? 0;
    }

    clearDedup(): void {
        this.#dedup.clear();
    }
}

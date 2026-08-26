// Synchronous to the first await: every matching handler runs to its first `await` before
// `dispatch` returns, and the promise it returns settles once they all finish.

import { BREAKER_THRESHOLD, MAX_DEDUP_KEYS, MAX_SEND_DEPTH } from '../config.js';
import type { EventPhase, HandlerDecl, HandlerKind, ScriptLocation } from '../script/index.js';
import { defaultConcurrency } from '../script/index.js';
import type { BreakerTrip, HandlerErrorRecord } from '../errors.js';
import { currentActingPlayer, setActingPlayer } from './acting-player.js';
import { currentInvocation, setCurrentInvocation, resumeWith } from './ambient.js';
import type { GuardOwner, ScopeTree } from './scope-tree.js';
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

/** Where a contained throw happened, for the log record and the breaker key. */
export interface GuardSite {
    /** What the breaker disables, paired with the owner's id. Not always a method name. */
    method: string;
    hostId: string;
    tick: number;
    /** The engine-side event name, `@`-prefixed like `@update`. */
    event: string;
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

    #onTrip: ((trip: BreakerTrip) => void) | null = null;

    constructor(scopes: ScopeTree, breaker: BreakerCounters, log: DispatchLog) {
        this.#scopes = scopes;
        this.#breaker = breaker;
        this.#log = log;
    }

    /**
     * Reports every breaker trip to the host. Diagnostics, not wire traffic — a disabled handler is
     * something whoever runs the server needs to see, and nothing a player's client can act on.
     */
    onTrip(listener: ((trip: BreakerTrip) => void) | null): void {
        this.#onTrip = listener;
    }

    /**
     * Runs creator code that reaches the engine outside a handler invocation — a movement tick, a
     * timer or tween callback, a countdown's completion — under the boundary a handler already gets.
     *
     * The same dedup, log and breaker as `#invoke`, because a second implementation of any of the
     * three would diverge from it the first time one is tuned. Returns false when the breaker has
     * already disabled this `(owner, method)` and `fn` was therefore not called.
     */
    guard(owner: GuardOwner | null, site: GuardSite, fn: () => void): boolean {
        // An unowned callback cannot be disabled — there is no instance to charge — but it is still
        // contained and logged, which is the half that keeps the tick alive.
        if (owner !== null && this.#breaker.count(owner.id, site.method) >= BREAKER_THRESHOLD) {
            return false;
        }
        try {
            fn();
        } catch (err) {
            this.#recordThrow(owner, site, err);
            return false;
        }
        if (owner !== null) this.#breaker.recordSuccess(owner.id, site.method);
        return true;
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

        const scope = this.#scopes.createInvocation(si.hostScopeId, tick, key, si);
        const site: GuardSite = { method, hostId, tick, event: decl.event };

        // Restored, not cleared: a nested synchronous send would otherwise return the outer handler
        // to its own body with no invocation, orphaning any timer it starts next.
        const outer = currentInvocation();
        const outerPlayer = currentActingPlayer();
        setCurrentInvocation(scope);
        // The acting player a wrapper defaults to; only the synchronous part of the handler is
        // covered, since a parked continuation resumes with no ambient of its own.
        setActingPlayer(ctx.player ?? null);
        let result: unknown;
        let called = false;
        try {
            // Inside the try because the read itself can run creator code: a handler declared as a
            // getter rather than a method invokes it here, and a throw would escape the boundary.
            const fn = (si.instance as Record<string, (c: DispatchCtx) => unknown>)[method];
            if (typeof fn === 'function') {
                called = true;
                result = fn.call(si.instance, ctx);
            }
        } catch (err) {
            this.#recordThrow(si, site, err);
            this.#scopes.completeInvocation(scope);
            setCurrentInvocation(outer);
            setActingPlayer(outerPlayer);
            return null;
        }
        setCurrentInvocation(outer);
        setActingPlayer(outerPlayer);

        if (!called) {
            this.#scopes.completeInvocation(scope);
            return null;
        }

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
                    this.#recordThrow(si, site, err);
                    this.#scopes.completeInvocation(scope);
                }
            },
        );
    }

    #recordThrow(owner: GuardOwner | null, site: GuardSite, err: unknown): void {
        const { method, hostId, tick, event } = site;
        const scriptClass = owner?.className ?? '(engine)';
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? message) : message;
        const dedupKey = `${scriptClass}#${method}#${message}`;
        const seen = (this.#dedup.get(dedupKey) ?? 0) + 1;
        // Bounded: a handler throwing with a fresh message each tick would otherwise grow this map
        // for the life of the process, and it exists only to keep the log readable.
        if (this.#dedup.size >= MAX_DEDUP_KEYS && seen === 1) this.#dedup.clear();
        this.#dedup.set(dedupKey, seen);

        // One record per distinct class#method#message; the repeats are counted, not logged.
        if (seen === 1) {
            this.#log.error({ scriptClass, method, hostId, tick, event, stack });
        }

        if (owner === null) return;
        const consecutive = this.#breaker.recordThrow(owner.id, method);
        if (consecutive === BREAKER_THRESHOLD) {
            const disabled = `handler disabled after ${BREAKER_THRESHOLD} consecutive throws`;
            this.#log.error({
                scriptClass,
                method,
                hostId,
                tick,
                event,
                stack: disabled,
                disabled: true,
            });
            this.#reportTrip({
                scriptClass,
                instanceId: owner.id,
                method,
                hostId,
                tick,
                event,
                stack,
            });
        }
    }

    /** The host's listener runs inside the tick, so its own throw is contained rather than fatal. */
    #reportTrip(trip: BreakerTrip): void {
        const listener = this.#onTrip;
        if (listener === null) return;
        try {
            listener(trip);
        } catch (err) {
            this.#log.error({
                scriptClass: '(host)',
                method: 'onBreakerTrip',
                hostId: trip.hostId,
                tick: trip.tick,
                event: trip.event,
                stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
        }
    }

    /** How many times `class#method#message` has thrown, including the suppressed repeats. */
    throwCount(scriptClass: string, method: string, message: string): number {
        return this.#dedup.get(`${scriptClass}#${method}#${message}`) ?? 0;
    }
}

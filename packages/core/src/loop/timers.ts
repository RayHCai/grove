// Timers: sleep / every / after (DESIGN §9). The loop ticks them at step 7. Each is
// owned by a scope (host or invocation) via §4.3's scope tree, so it auto-cancels when
// its host dies. Time is counted in ticks internally; the public API is seconds.
//
// This is simulation state and registers with the snapshot (§8.1). `sleep` promises are
// heap closures the snapshot cannot capture, so a rewind resolves them dead rather than
// replaying them — see the parked-invocation sweep in the runtime.

import type { ScopeId } from '../dispatch/scope-tree.js';
import type { Scope, ScopeMode, SnapshotStore } from './store-registry.js';

export type TimerKind = 'sleep' | 'every' | 'after';

interface Timer {
    id: number;
    kind: TimerKind;
    hostScopeId: ScopeId;
    /** Ticks remaining until fire. */
    remaining: number;
    /** Reload interval in ticks, for `every`. */
    interval: number;
    fn: (() => void) | null;
    resolve: (() => void) | null;
    cancelled: boolean;
}

export interface TimerBuffer {
    timers: Array<Omit<Timer, 'fn' | 'resolve'>>;
    nextId: number;
}

export class TimerHeap implements SnapshotStore<TimerBuffer> {
    readonly storeName = 'timers';
    readonly scopeMode: ScopeMode = 'filtered';

    readonly #timers = new Map<number, Timer>();
    #nextId = 1;
    #simRate = 60;

    /** Maps a scope id to the entity id that owns it, for scoped snapshot filtering. */
    #scopeOwner: (scopeId: ScopeId) => number = () => -1;

    setSimRate(rate: number): void {
        this.#simRate = rate;
    }

    setScopeOwnerLookup(lookup: (scopeId: ScopeId) => number): void {
        this.#scopeOwner = lookup;
    }

    /** Schedules a one-shot `after`. Returns a cancel function. */
    after(seconds: number, hostScopeId: ScopeId, fn: () => void): () => void {
        const id = this.#nextId++;
        this.#timers.set(id, {
            id,
            kind: 'after',
            hostScopeId,
            remaining: this.#toTicks(seconds),
            interval: 0,
            fn,
            resolve: null,
            cancelled: false,
        });
        return () => this.cancel(id);
    }

    /** Schedules a repeating `every`. Returns a cancel function. */
    every(seconds: number, hostScopeId: ScopeId, fn: () => void): () => void {
        const id = this.#nextId++;
        const ticks = this.#toTicks(seconds);
        this.#timers.set(id, {
            id,
            kind: 'every',
            hostScopeId,
            remaining: ticks,
            interval: ticks,
            fn,
            resolve: null,
            cancelled: false,
        });
        return () => this.cancel(id);
    }

    /** Schedules a `sleep`; the returned promise resolves when it fires. */
    sleep(seconds: number, hostScopeId: ScopeId): Promise<void> {
        const id = this.#nextId++;
        return new Promise<void>(resolve => {
            this.#timers.set(id, {
                id,
                kind: 'sleep',
                hostScopeId,
                remaining: this.#toTicks(seconds),
                interval: 0,
                fn: null,
                resolve,
                cancelled: false,
            });
        });
    }

    cancel(id: number): void {
        const timer = this.#timers.get(id);
        if (!timer) return;
        timer.cancelled = true;
        // A cancelled sleep never resolves — its continuation is unreachable (§4.3, §8.1).
        this.#timers.delete(id);
    }

    /** Cancels every timer owned by a scope — the host-destroy cascade (§4.3). */
    cancelScope(hostScopeId: ScopeId): void {
        for (const [id, timer] of this.#timers) {
            if (timer.hostScopeId === hostScopeId) {
                timer.cancelled = true;
                this.#timers.delete(id);
            }
        }
    }

    /**
     * Advances every timer by one tick and fires those that reach zero. Fire order is by
     * ascending timer id — the engine-stable order determinism requires (§1.2).
     */
    advance(): void {
        const due: Timer[] = [];
        for (const timer of this.#timers.values()) {
            timer.remaining -= 1;
            if (timer.remaining <= 0) due.push(timer);
        }
        due.sort((a, b) => a.id - b.id);

        for (const timer of due) {
            if (timer.cancelled) continue;
            if (timer.kind === 'every') {
                timer.remaining += timer.interval;
                timer.fn?.();
            } else {
                this.#timers.delete(timer.id);
                if (timer.kind === 'after') timer.fn?.();
                else timer.resolve?.();
            }
        }
    }

    get pendingCount(): number {
        return this.#timers.size;
    }

    clear(): void {
        this.#timers.clear();
    }

    #toTicks(seconds: number): number {
        return Math.max(1, Math.round(seconds * this.#simRate));
    }

    // ─── snapshot/restore ────────────────────────────────────────────────────────
    // Only sleeps carry a resolve closure the snapshot cannot hold. after/every carry a
    // creator fn also uncapturable. So restore keeps the timing but not the closure — a
    // parked timer is swept by the runtime's rewind (§8.1), not resurrected here.

    createBuffer(): TimerBuffer {
        return { timers: [], nextId: 1 };
    }

    capture(into: TimerBuffer, scope: Scope): void {
        into.nextId = this.#nextId;
        into.timers = [];
        for (const t of this.#timers.values()) {
            if (scope !== null) {
                const owner = this.#scopeOwner(t.hostScopeId);
                if (owner < 0 || ![...scope].some(id => (id as number) % 0x100_0000 === owner)) {
                    continue;
                }
            }
            into.timers.push({
                id: t.id,
                kind: t.kind,
                hostScopeId: t.hostScopeId,
                remaining: t.remaining,
                interval: t.interval,
                cancelled: t.cancelled,
            });
        }
    }

    apply(from: TimerBuffer): void {
        // A rewind drops parked closures; keep only the timing skeleton for the swept set.
        // Timers whose closures survived in the live map (same id) keep their fn/resolve.
        const surviving = new Map<number, Timer>();
        for (const meta of from.timers) {
            const live = this.#timers.get(meta.id);
            surviving.set(meta.id, {
                ...meta,
                fn: live?.fn ?? null,
                resolve: live?.resolve ?? null,
            });
        }
        this.#timers.clear();
        for (const [id, t] of surviving) this.#timers.set(id, t);
        this.#nextId = from.nextId;
    }
}

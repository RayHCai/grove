// Every timer is owned by a scope, so it auto-cancels when its host dies. Time is counted in
// ticks internally and in seconds at the API, so a timer cannot drift with frame rate.

import type { ScopeId } from '../dispatch/scope-tree.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';
import { entityIndex } from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from './store-registry.js';

export type TimerKind = 'sleep' | 'every' | 'after';

interface Timer {
    id: number;
    kind: TimerKind;
    hostScopeId: ScopeId;
    remaining: number;
    /** Reload interval, `every` only; zero for one-shots. */
    interval: number;
    fn: (() => void) | null;
    resolve: (() => void) | null;
    cancelled: boolean;
}

export interface TimerBuffer {
    timers: Array<Omit<Timer, 'fn' | 'resolve'>>;
    nextId: number;
    /** Host scopes this buffer covers, or null for every timer; a scoped `apply` replaces only these. */
    scopes: Set<ScopeId> | null;
}

export class TimerHeap implements SnapshotStore<TimerBuffer> {
    readonly storeName = 'timers';
    readonly scopeMode: ScopeMode = 'filtered';

    readonly #timers = new Map<number, Timer>();
    #nextId = 1;
    #simRate = 60;

    /** Scope id → owning entity id; only a scoped capture needs it. */
    #scopeOwner: (scopeId: ScopeId) => number = () => -1;

    setSimRate(rate: number): void {
        this.#simRate = rate;
    }

    setScopeOwnerLookup(lookup: (scopeId: ScopeId) => number): void {
        this.#scopeOwner = lookup;
    }

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

    sleep(seconds: number, hostScopeId: ScopeId): Promise<void> {
        const id = this.#nextId++;
        return new Promise<void>((resolve) => {
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
        // A cancelled sleep never resolves — its continuation is meant to be unreachable.
        this.#timers.delete(id);
    }

    /** Cancels every timer owned by a scope — the host-destroy cascade. */
    cancelScope(hostScopeId: ScopeId): void {
        // NO_SCOPE is every hostless timer at once, never one host's, so no teardown may claim it.
        if (hostScopeId === NO_SCOPE) return;
        for (const [id, timer] of this.#timers) {
            if (timer.hostScopeId === hostScopeId) {
                timer.cancelled = true;
                this.#timers.delete(id);
            }
        }
    }

    /** Advances every timer a tick, firing in ascending id order because determinism needs one. */
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
        // A non-finite duration would make `remaining` NaN, and NaN <= 0 is false forever, so the
        // timer would neither fire nor ever leave the heap.
        if (!Number.isFinite(seconds)) {
            throw new RangeError(
                `timer duration must be a finite number of seconds, got ${seconds}`,
            );
        }
        return Math.max(1, Math.round(seconds * this.#simRate));
    }

    createBuffer(): TimerBuffer {
        return { timers: [], nextId: 1, scopes: null };
    }

    capture(into: TimerBuffer, scope: Scope): void {
        into.nextId = this.#nextId;
        into.timers = [];

        if (scope === null) {
            into.scopes = null;
        } else {
            const owners = new Set<number>();
            for (const id of scope) owners.add(entityIndex(id));
            const scopes = new Set<ScopeId>();
            for (const t of this.#timers.values()) {
                const owner = this.#scopeOwner(t.hostScopeId);
                if (owner >= 0 && owners.has(owner)) scopes.add(t.hostScopeId);
            }
            into.scopes = scopes;
        }

        for (const t of this.#timers.values()) {
            if (into.scopes !== null && !into.scopes.has(t.hostScopeId)) continue;
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
        // A buffer cannot hold closures, so a restored timer keeps only its timing and borrows
        // fn/resolve from the live timer of the same id.
        const restored = new Map<number, Timer>();
        for (const meta of from.timers) {
            const live = this.#timers.get(meta.id);
            restored.set(meta.id, {
                ...meta,
                fn: live?.fn ?? null,
                resolve: live?.resolve ?? null,
            });
        }

        if (from.scopes === null) {
            this.#timers.clear();
            // A replay has to mint the same ids as the original run, so the counter rewinds too.
            this.#nextId = from.nextId;
        } else {
            // Clearing every timer would cancel the ones this scope never captured, and their ids
            // are already spent, so the counter only ever moves forward here.
            for (const [id, t] of this.#timers) {
                if (from.scopes.has(t.hostScopeId)) this.#timers.delete(id);
            }
            this.#nextId = Math.max(this.#nextId, from.nextId);
        }
        for (const [id, t] of restored) this.#timers.set(id, t);
    }
}

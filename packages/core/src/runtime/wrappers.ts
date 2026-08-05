// The data wrappers (DESIGN §5.2, §6.2, api_spec.ts:952). The four stateful wrappers share
// StatefulWrapper: a field holding one is authoritative WITHOUT @serverState because the
// wrapper's own methods mark the replication channel. `bind` supplies the identity a field
// initializer lacks (which record to mark, under which name), throws if bound twice, and
// `serialize`/`restore` give persistence one interface tagged by class identity.
//
// Countdown and Storage stay outside the base: a countdown is derived from its clock, and
// Storage is the key-value escape hatch rather than replicated state (§5.2).

import type { HostRecord } from '../state/host-record.js';
import type { Player } from './player.js';
import type { KVStore } from './seams.js';

export abstract class StatefulWrapper {
    #record: HostRecord | null = null;
    #field = '';

    /** Called by wiring. Throws if the same instance is bound twice (§5.2). */
    bind(record: object, fieldName: string): void {
        if (this.#record) {
            throw new Error(
                `wrapper already bound to "${this.#field}" — sharing one instance between hosts is a load-time error (§5.2)`,
            );
        }
        this.#record = record as HostRecord;
        this.#field = fieldName;
    }

    /** Marks this wrapper's key on the state channel — every mutating method calls it. */
    protected mark(): void {
        this.#record?.markDirty?.(this.#field);
    }

    abstract serialize(): unknown;
    abstract restore(data: unknown): void;

    protected get bound(): boolean {
        return this.#record !== null;
    }

    protected requireBound(): void {
        if (!this.#record) {
            throw new Error('wrapper used before assignment to a field — nothing to mark or persist (§5.2)');
        }
    }
}

export class Scoreboard extends StatefulWrapper {
    readonly #scores = new Map<string, number>();
    #actingPlayer: Player | null = null;

    /** @internal — set by the dispatcher so `add(1)` can default to the acting player. */
    setActingPlayer(player: Player | null): void {
        this.#actingPlayer = player;
    }

    add(amount: number, player?: Player): void {
        this.requireBound();
        const p = player ?? this.#actingPlayer;
        if (!p) return;
        this.#scores.set(p.id, (this.#scores.get(p.id) ?? 0) + amount);
        this.mark();
    }

    set(amount: number, player?: Player): void {
        this.requireBound();
        const p = player ?? this.#actingPlayer;
        if (!p) return;
        this.#scores.set(p.id, amount);
        this.mark();
    }

    of(player: Player): number {
        return this.#scores.get(player.id) ?? 0;
    }

    top(n: number): Player[] {
        const pm = playerLookup();
        return [...this.#scores.entries()]
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([id]) => pm(id))
            .filter((p): p is Player => p !== null);
    }

    reset(): void {
        this.requireBound();
        this.#scores.clear();
        this.mark();
    }

    serialize(): unknown {
        return { kind: 'Scoreboard', scores: [...this.#scores.entries()] };
    }

    restore(data: unknown): void {
        const d = data as { kind?: string; scores?: [string, number][] };
        if (d?.kind !== 'Scoreboard') return;
        this.#scores.clear();
        for (const [id, s] of d.scores ?? []) this.#scores.set(id, s);
    }
}

export class Leaderboard extends StatefulWrapper {
    readonly #order: 'high' | 'low';
    readonly persist: boolean;
    readonly #scores = new Map<string, number>();

    constructor(opts?: { order?: 'high' | 'low'; persist?: boolean }) {
        super();
        this.#order = opts?.order ?? 'high';
        this.persist = opts?.persist ?? true;
    }

    submit(score: number, player?: Player): void {
        this.requireBound();
        if (!player) return;
        const prev = this.#scores.get(player.id);
        const better = prev === undefined || (this.#order === 'high' ? score > prev : score < prev);
        if (better) {
            this.#scores.set(player.id, score);
            this.mark();
        }
    }

    of(player: Player): number {
        return this.#scores.get(player.id) ?? 0;
    }

    #ranked(): Array<[string, number]> {
        return [...this.#scores.entries()].toSorted((a, b) =>
            this.#order === 'high' ? b[1] - a[1] : a[1] - b[1],
        );
    }

    top(n: number): Array<{ player: Player; score: number }> {
        const pm = playerLookup();
        return this.#ranked()
            .slice(0, n)
            .map(([id, score]) => ({ player: pm(id), score }))
            .filter((r): r is { player: Player; score: number } => r.player !== null);
    }

    rankOf(player: Player): number {
        const at = this.#ranked().findIndex(([id]) => id === player.id);
        return at < 0 ? 0 : at + 1;
    }

    serialize(): unknown {
        return { kind: 'Leaderboard', order: this.#order, scores: [...this.#scores.entries()] };
    }

    restore(data: unknown): void {
        const d = data as { kind?: string; scores?: [string, number][] };
        if (d?.kind !== 'Leaderboard') return;
        this.#scores.clear();
        for (const [id, s] of d.scores ?? []) this.#scores.set(id, s);
    }
}

export class Inventory extends StatefulWrapper {
    readonly #player: Player;
    readonly #items = new Map<string, number>();

    constructor(player: Player) {
        super();
        this.#player = player;
    }

    get player(): Player {
        return this.#player;
    }

    add(item: string, count = 1): void {
        this.requireBound();
        this.#items.set(item, (this.#items.get(item) ?? 0) + count);
        this.mark();
    }

    remove(item: string, count = 1): void {
        this.requireBound();
        const next = (this.#items.get(item) ?? 0) - count;
        if (next <= 0) this.#items.delete(item);
        else this.#items.set(item, next);
        this.mark();
    }

    has(item: string): boolean {
        return (this.#items.get(item) ?? 0) > 0;
    }

    count(item: string): number {
        return this.#items.get(item) ?? 0;
    }

    clear(): void {
        this.requireBound();
        this.#items.clear();
        this.mark();
    }

    serialize(): unknown {
        return { kind: 'Inventory', items: [...this.#items.entries()] };
    }

    restore(data: unknown): void {
        const d = data as { kind?: string; items?: [string, number][] };
        if (d?.kind !== 'Inventory') return;
        this.#items.clear();
        for (const [item, c] of d.items ?? []) this.#items.set(item, c);
    }
}

export class Team extends StatefulWrapper {
    readonly name: string;
    readonly #members = new Set<string>();

    constructor(name: string) {
        super();
        this.name = name;
    }

    get players(): Player[] {
        const pm = playerLookup();
        return [...this.#members].map(id => pm(id)).filter((p): p is Player => p !== null);
    }

    add(player: Player): void {
        this.requireBound();
        this.#members.add(player.id);
        this.mark();
    }

    remove(player: Player): void {
        this.requireBound();
        this.#members.delete(player.id);
        this.mark();
    }

    has(player: Player): boolean {
        return this.#members.has(player.id);
    }

    serialize(): unknown {
        return { kind: 'Team', name: this.name, members: [...this.#members] };
    }

    restore(data: unknown): void {
        const d = data as { kind?: string; members?: string[] };
        if (d?.kind !== 'Team') return;
        this.#members.clear();
        for (const id of d.members ?? []) this.#members.add(id);
    }
}

// Countdown: server-ticked, replicated; onZero fires once on reaching 0 (§12.11). The loop
// ticks it (§8.2 step 7). Not a StatefulWrapper — derived from the clock.
export class Countdown {
    #remainingTicks: number;
    #running = false;
    #fired = false;
    readonly #onZero: (() => void) | undefined;
    #simRate = 60;

    constructor(seconds: number, onZero?: () => void) {
        this.#remainingTicks = Math.max(0, Math.round(seconds * this.#simRate));
        this.#onZero = onZero;
    }

    /** @internal — the loop sets the rate and advances the countdown each tick. */
    setSimRate(rate: number): void {
        this.#simRate = rate;
    }

    get remaining(): number {
        return this.#remainingTicks / this.#simRate;
    }

    start(): void {
        this.#running = true;
    }

    pause(): void {
        this.#running = false;
    }

    reset(seconds?: number): void {
        if (seconds !== undefined) this.#remainingTicks = Math.max(0, Math.round(seconds * this.#simRate));
        this.#fired = false;
    }

    /** @internal — the loop advances a running countdown one tick and fires onZero once. */
    advance(): void {
        if (!this.#running || this.#remainingTicks <= 0) return;
        this.#remainingTicks -= 1;
        if (this.#remainingTicks <= 0 && !this.#fired) {
            this.#fired = true;
            this.#running = false;
            this.#onZero?.();
        }
    }
}

// Storage: per-player or global key/value over the KVStore seam (§5.4). ServerScript-only
// reads (enforced at runtime now, at load once the AST pass exists).
export class Storage {
    readonly #kv: KVStore;
    readonly #scope: string;

    constructor(kv: KVStore, scope: string) {
        this.#kv = kv;
        this.#scope = scope;
    }

    get(key: string): Promise<unknown> {
        return this.#kv.get(this.#scope, key);
    }

    set(key: string, value: unknown): Promise<void> {
        return this.#kv.set(this.#scope, key, value);
    }

    delete(key: string): Promise<void> {
        return this.#kv.delete(this.#scope, key);
    }
}

// A wrapper marks its record's dirty set; the record carries the marking closure the
// wiring step installs, so the wrapper needn't know the channels' shape.
let resolvePlayer: (id: string) => Player | null = () => null;

/** @internal — the runtime installs the player lookup so top()/players() resolve ids. */
export function setPlayerLookup(fn: (id: string) => Player | null): void {
    resolvePlayer = fn;
}

function playerLookup(): (id: string) => Player | null {
    return resolvePlayer;
}

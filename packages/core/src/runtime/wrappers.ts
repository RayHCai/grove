// A field holding a StatefulWrapper is authoritative without @serverState: the wrapper's own
// mutating methods mark the replication channel.

import type { HostRecord } from '../state/host-record.js';
import type { Player } from './player.js';
import type { KVStore } from './seams.js';
import { currentRuntime, hasRuntime } from './runtime.js';
import { DEFAULT_SIM_RATE } from '../config.js';

export abstract class StatefulWrapper {
    #record: HostRecord | null = null;
    #field = '';

    /** Called by wiring; throws if the same instance is bound twice. */
    bind(record: object, fieldName: string): void {
        if (this.#record) {
            throw new Error(
                `wrapper already bound to "${this.#field}" — sharing one instance between hosts is a load-time error`,
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
            throw new Error(
                'wrapper used before assignment to a field — nothing to mark or persist',
            );
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
        const p = this.#require(player, 'add');
        this.#scores.set(p.id, (this.#scores.get(p.id) ?? 0) + amount);
        this.mark();
    }

    set(amount: number, player?: Player): void {
        this.requireBound();
        const p = this.#require(player, 'set');
        this.#scores.set(p.id, amount);
        this.mark();
    }

    // Throwing, not returning: a silent no-op here loses a score the creator believed was
    // recorded, and the acting-player default is only available inside a player-driven handler.
    #require(player: Player | undefined, method: string): Player {
        const p = player ?? this.#actingPlayer;
        if (!p) {
            throw new Error(
                `Scoreboard.${method} needs a player — there is no acting player outside a handler driven by one`,
            );
        }
        return p;
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
        // Throwing rather than dropping the score: nothing here can infer whose it was.
        if (!player) throw new Error('Leaderboard.submit needs the player whose score it is');
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
        return [...this.#members].map((id) => pm(id)).filter((p): p is Player => p !== null);
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

// Not a StatefulWrapper: it is advanced a tick at a time and no method here marks the state channel.
export class Countdown {
    #remainingTicks: number;
    #running = false;
    #fired = false;
    readonly #onZero: (() => void) | undefined;
    #simRate: number;

    constructor(seconds: number, onZero?: () => void) {
        // The live rate, not a hardcoded 60: a countdown built on a 30 Hz world would otherwise
        // hold twice the ticks it was asked for and report twice the seconds.
        this.#simRate = hasRuntime() ? currentRuntime().simRate : DEFAULT_SIM_RATE;
        this.#remainingTicks = Math.max(0, Math.round(seconds * this.#simRate));
        this.#onZero = onZero;
    }

    /** @internal — set by the loop; rescales so the remaining time survives a rate change. */
    setSimRate(rate: number): void {
        if (rate <= 0 || rate === this.#simRate) return;
        this.#remainingTicks = Math.max(
            0,
            Math.round((this.#remainingTicks / this.#simRate) * rate),
        );
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
        if (seconds !== undefined)
            this.#remainingTicks = Math.max(0, Math.round(seconds * this.#simRate));
        this.#fired = false;
    }

    /** @internal — driven by the loop, one tick per call. */
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

// Resolved per call off the runtime rather than through a module slot: with the lookup held in
// this module, a second loadGame handed world A's scoreboard world B's Player objects.
function playerLookup(): (id: string) => Player | null {
    if (!hasRuntime()) return () => null;
    const rt = currentRuntime();
    return (id: string) => rt.playerManager?.byId(id) ?? null;
}

// A field holding a StatefulWrapper is authoritative without @serverState: the wrapper's own
// mutating methods mark the replication channel.

import type { HostRecord } from '../state/host-record.js';
import { currentActingPlayer } from '../dispatch/acting-player.js';
import { currentInvocation } from '../dispatch/ambient.js';
import type { GuardOwner } from '../dispatch/scope-tree.js';
import type { Player } from './player.js';
import type { KVStore } from './seams.js';
import type { Runtime } from './runtime.js';
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
        const p = player ?? (currentActingPlayer() as Player | null);
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
        restoreCounts(this.#scores, data, 'Scoreboard', 'scores');
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
        restoreCounts(this.#scores, data, 'Leaderboard', 'scores');
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
        // The player rides along because it is a constructor argument, and a receiver holding no
        // scripts has to rebuild this from the payload alone.
        return {
            kind: 'Inventory',
            player: this.#player.id,
            items: [...this.#items.entries()],
        };
    }

    restore(data: unknown): void {
        restoreCounts(this.#items, data, 'Inventory', 'items');
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

let nextCountdownId = 1;

/** The wrappers whose state replicates, named by the tag their serialized form carries. */
export type WrapperKind = 'Scoreboard' | 'Leaderboard' | 'Inventory' | 'Team';

/**
 * A host field as the wire carries it: a bound wrapper's `serialize()`, everything else raw.
 *
 * What the record holds for a wrapper field is the wrapper OBJECT, and no codec represents a class
 * instance — so without this the mark is dropped at the send boundary and counted, which is a silent
 * loss by construction: the channel was marked, so everything upstream looks like it worked.
 */
export function serializeHostField(record: HostRecord, field: string): unknown {
    const value = record.values.get(field);
    return value instanceof StatefulWrapper ? value.serialize() : value;
}

/**
 * Lands a replicated value on a host field.
 *
 * A wrapper already on the record is RESTORED in place rather than replaced, because a script may
 * hold that same instance and assigning the decoded payload over it would leave a methodless object
 * where a `Scoreboard` was. A receiver holding none — the ordinary client, which runs no scripts —
 * revives one from the payload's own tag instead, so `of()` and `top()` work on both ends.
 */
export function restoreHostField(record: HostRecord, field: string, value: unknown): void {
    const held = record.values.get(field);
    if (held instanceof StatefulWrapper) {
        held.restore(value);
        return;
    }
    const revived = reviveWrapper(value);
    if (revived === undefined) {
        record.values.set(field, value);
        return;
    }
    revived.bind(record, field);
    revived.restore(value);
    record.values.set(field, revived);
    record.wrappers.add(field);
}

/**
 * Rebuilds a wrapper from its serialized form, or `undefined` when the payload is not one.
 *
 * Keyed off the payload's own `kind`, since a receiver with no scripts has nothing else to go on —
 * which is also why every constructor argument has to ride the wire. An `Inventory` naming a player
 * this world does not know is left as the raw payload rather than attached to a guess.
 */
export function reviveWrapper(data: unknown): StatefulWrapper | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const d = data as { kind?: unknown; order?: unknown; name?: unknown; player?: unknown };
    switch (d.kind as WrapperKind) {
        case 'Scoreboard':
            return new Scoreboard();
        case 'Leaderboard':
            // The order decides what `top` means, so a default here would silently invert a
            // low-is-better board on every client.
            return new Leaderboard({ order: d.order === 'low' ? 'low' : 'high' });
        case 'Team':
            return typeof d.name === 'string' ? new Team(d.name) : undefined;
        case 'Inventory': {
            const player = typeof d.player === 'string' ? playerLookup()(d.player) : null;
            return player === null ? undefined : new Inventory(player);
        }
        default:
            return undefined;
    }
}

type WirePayload = { kind?: string } & Record<string, unknown>;

// A payload tagged with another wrapper's kind is left alone: the field it came from may since
// hold a different class, and a half-applied restore is worse than none.
function restoreCounts(
    into: Map<string, number>,
    data: unknown,
    kind: string,
    field: string,
): void {
    const d = data as WirePayload;
    if (d?.kind !== kind) return;
    const entries = (d[field] as [string, number][] | undefined) ?? [];
    into.clear();
    for (const [key, count] of entries) into.set(key, count);
}

// Not a StatefulWrapper: it is advanced a tick at a time and no method here marks the state channel.
export class Countdown {
    #remainingTicks: number;
    #running = false;
    #fired = false;
    readonly #onZero: (() => void) | undefined;
    #simRate: number;
    /**
     * The runtime whose countdowns pass advances this one; null when built outside a loaded world.
     *
     * Captured rather than resolved per call, so a countdown built inside `withRuntime` still
     * belongs to that world when a later tick reaches it.
     */
    readonly #rt: Runtime | null;

    /** @internal — who registered it, so a throw in `onZero` is charged like a timer callback's. */
    readonly owner: GuardOwner | null;
    /** @internal — the breaker key, since `onZero` is a closure the breaker could not otherwise name. */
    readonly guardKey: string;

    constructor(seconds: number, onZero?: () => void) {
        this.owner = currentInvocation()?.owner ?? null;
        this.guardKey = `countdown:${nextCountdownId++}`;
        // The live rate, not a hardcoded 60: a countdown built on a 30 Hz world would otherwise
        // hold twice the ticks it was asked for and report twice the seconds.
        this.#rt = hasRuntime() ? currentRuntime() : null;
        this.#simRate = this.#rt?.simRate ?? DEFAULT_SIM_RATE;
        this.#remainingTicks = Math.max(0, Math.round(seconds * this.#simRate));
        this.#onZero = onZero;
    }

    get remaining(): number {
        return this.#remainingTicks / this.#simRate;
    }

    get running(): boolean {
        return this.#running;
    }

    // Registered on start rather than on construction: the set holds a strong reference, so a game
    // minting one per round would otherwise grow it for the session.
    start(): void {
        this.#running = true;
        this.#rt?.countdowns.add(this);
    }

    pause(): void {
        this.#running = false;
        this.#rt?.countdowns.delete(this);
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
            // Deregistered before the callback, so an onZero that restarts it re-registers rather
            // than having this line drop it again.
            this.#rt?.countdowns.delete(this);
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

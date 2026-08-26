// The registry record and its admission bookkeeping.
//
// Keyed by a server-minted connectionId, never by player id: a dropped socket and its replacement
// are two connections that must bind to one Player, so player identity cannot be the key.

import type { Player } from '@platform/core';
import { createActionStates } from '@platform/core';
import type { ActionStates } from '@platform/core';
import type { Interaction, JoinRequest } from '@platform/protocol';
import type { Transport } from '@platform/transport';
import {
    CONTROL_BUCKET_FRAMES,
    INPUT_BUCKET_FRAMES,
    MAX_ACTION_NAMES,
    controlRefillTicks,
} from './constants.js';

/** Why a frame was refused. Reported by the ack advancing past it, never by an envelope. */
export type RefusalReason = 'too-old' | 'too-far-future' | 'rate';

/** What `AdmissionState.takeAck` reports for one connection on one send-tick. */
export interface AckReport {
    ackSeq: number;
    /** Absent when this ack resolved no input — never `undefined`, which the codec refuses. */
    earliestHeadroom?: number;
}

/**
 * Per-connection admission state: the resolution frontier, the headroom samples riding its acks,
 * and the rate limiters.
 *
 * The frontier is not a high-water mark. `ackSeq` is the highest `n` with every seq `≤ n` resolved —
 * applied or definitively rejected — so a refusal advances the ack past itself while a gap holds it
 * back; either half alone passes under a high-water-mark implementation.
 */
export class AdmissionState {
    /** -1 = nothing resolved, matching the client's own start. */
    #frontier = -1;
    readonly #resolved = new Set<number>();
    /** seq → `frame.tick - serverTickOnArrival`, for whichever ack resolves it. */
    readonly #headroom = new Map<number, number>();
    /**
     * A seq above the frontier that has not arrived, and the latest tick it can name.
     *
     * Datable because seq and tick advance together: a missing seq named a tick no later than the
     * next seq that did arrive, so once that bound leaves the past grace it can never be applied.
     */
    readonly #gapTickBound = new Map<number, number>();
    #highestSeen = -1;

    /** Action names this connection has ever named, bounded so a peer cannot grow core's fold without limit. */
    readonly #actionNames = new Set<string>();

    #tokens = INPUT_BUCKET_FRAMES;
    #controlTokens = CONTROL_BUCKET_FRAMES;
    #ticksSinceControlRefill = 0;
    #rateRefusals = 0;
    /** The last tick any well-formed frame arrived on — the stale-hold backstop's clock. */
    #lastInputTick = 0;

    /** The number the client prunes its ring against. */
    get ackSeq(): number {
        return this.#frontier;
    }

    get rateRefusals(): number {
        return this.#rateRefusals;
    }

    get lastInputTick(): number {
        return this.#lastInputTick;
    }

    /** Seqs resolved but not yet contiguous — a gap's cost, and a test's window into it. */
    get pendingResolved(): number {
        return this.#resolved.size;
    }

    /** The highest seq seen, which is what the arrival bound is measured from. */
    get highestSeen(): number {
        return this.#highestSeen;
    }

    /**
     * Records that `seq` arrived on `serverTick` naming `frameTick`, before it is admitted or
     * refused, dating any gap it skipped so the abandonment rule has a bound to work from.
     */
    noteArrival(seq: number, frameTick: number, serverTick: number): void {
        this.noteTraffic(serverTick);
        // Only above the frontier: a replayed seq the frontier has already passed would leave a
        // sample no `takeAck` walk ever reaches, so the map would grow for the life of the session.
        if (seq > this.#frontier) this.#headroom.set(seq, frameTick - serverTick);
        for (let missing = this.#highestSeen + 1; missing < seq; missing++) {
            if (!this.#resolved.has(missing)) this.#gapTickBound.set(missing, frameTick);
        }
        if (seq > this.#highestSeen) this.#highestSeen = seq;
    }

    /**
     * Restarts the stale-hold clock, at join too: a player joining at tick 500 must not be born
     * `holdStaleTicks` silent against a counter that started at zero.
     */
    noteTraffic(serverTick: number): void {
        this.#lastInputTick = serverTick;
    }

    /** Marks `seq` settled — applied, or definitively rejected; both resolve it. */
    resolve(seq: number): void {
        if (seq <= this.#frontier) return;
        this.#resolved.add(seq);
        this.#gapTickBound.delete(seq);
    }

    /**
     * Abandons every gap seq whose latest possible tick is already out of the past grace: it can
     * never be applied, so holding the frontier behind it stalls the client's ring on a frame that
     * is not coming.
     */
    abandonStale(currentTick: number, pastGrace: number): void {
        const floor = currentTick - pastGrace;
        for (const [seq, tickBound] of this.#gapTickBound) {
            if (tickBound < floor) {
                this.#gapTickBound.delete(seq);
                this.#resolved.add(seq);
            }
        }
    }

    /**
     * Advances the frontier as far as it is contiguous and reports the ack, with the headroom of the
     * earliest input it resolved — the tail, not the mean, because a lead sized to the mean drops
     * the tail and a player feels that as occasional unresponsiveness.
     */
    takeAck(): AckReport {
        let earliest: number | undefined;
        for (let next = this.#frontier + 1; this.#resolved.has(next); next++) {
            this.#resolved.delete(next);
            this.#frontier = next;
            const sample = this.#headroom.get(next);
            this.#headroom.delete(next);
            // An abandoned seq never arrived, so it has no sample and describes no arrival.
            if (earliest === undefined && sample !== undefined) earliest = sample;
        }
        const report: AckReport = { ackSeq: this.#frontier };
        if (earliest !== undefined) report.earliestHeadroom = earliest;
        return report;
    }

    /** Refills one input token per stepped tick, and one control token per `CONTROL_REFILL_MS`. */
    refill(simRate: number): void {
        if (this.#tokens < INPUT_BUCKET_FRAMES) this.#tokens++;
        if (++this.#ticksSinceControlRefill < controlRefillTicks(simRate)) return;
        this.#ticksSinceControlRefill = 0;
        if (this.#controlTokens < CONTROL_BUCKET_FRAMES) this.#controlTokens++;
    }

    /** Spends an input token, or reports the connection is over its ceiling. */
    takeToken(): boolean {
        if (this.#tokens <= 0) {
            this.#rateRefusals++;
            return false;
        }
        this.#tokens--;
        return true;
    }

    /**
     * Spends a token for a `join-request` or `time-sync`.
     *
     * A separate bucket because the input one does not cover them and both are far more expensive
     * per frame than an input: a resync buys a full world walk, a `time-sync` a reply.
     */
    takeControlToken(): boolean {
        if (this.#controlTokens <= 0) return false;
        this.#controlTokens--;
        return true;
    }

    /**
     * Whether this connection may still name `action`.
     *
     * The name reaches core's fold as a map key and stays there, and every held action costs a
     * synthesized `hold` dispatch every tick — so an unbounded key space is unbounded per-tick work
     * bought with one frame.
     */
    admitsAction(action: string): boolean {
        if (this.#actionNames.has(action)) return true;
        if (this.#actionNames.size >= MAX_ACTION_NAMES) return false;
        this.#actionNames.add(action);
        return true;
    }
}

/** A live connection: the transport to one peer, the Player it was allocated, and its admission bookkeeping. */
export class Connection {
    readonly connectionId: string;
    readonly transport: Transport;
    readonly admission = new AdmissionState();
    /** Disposers from `transport.onMessage` / `onClose`, run once on drop. */
    readonly disposers: (() => void)[] = [];
    /**
     * This connection's folded input.
     *
     * Core's fold, not a second implementation: two would diverge, and the divergence surfaces as a
     * prediction mismatch debugged as a replication bug.
     */
    readonly actions: ActionStates = createActionStates();
    /**
     * HUD presses and pointer hits awaiting the next tick pass.
     *
     * A queue rather than an immediate dispatch, because a handler reached from a socket callback
     * would run between ticks. It needs no depth of its own: the input bucket bounds how many frames
     * reach it and the pass empties it every tick.
     */
    readonly interactions: Interaction[] = [];

    /** Null until the first valid `JoinRequest` allocates it. */
    player: Player | null = null;
    /**
     * The `JoinRequest` still owed a `Welcome`, answered at the next send-tick.
     *
     * Non-null means the Player exists but its snapshot has not been taken, so the broadcast skips
     * this connection: everything in that send predates the snapshot it is about to receive. The
     * request is held rather than a flag because only it carries the `clientSentMs` to echo.
     */
    pendingJoin: JoinRequest | null = null;
    /**
     * The pump clock reading at `accept`, against which the join deadline is measured.
     *
     * Null when accepted before the first wake: the injected clock's epoch is unknown until then, so
     * a host passing `Date.now() / 1000` would expire every connection stamped 0.
     */
    acceptedAtSeconds: number | null;
    closed = false;

    constructor(connectionId: string, transport: Transport, acceptedAtSeconds: number | null) {
        this.connectionId = connectionId;
        this.transport = transport;
        this.acceptedAtSeconds = acceptedAtSeconds;
    }

    get joined(): boolean {
        return this.player !== null;
    }

    /**
     * Structural ops still held over from before this connection's snapshot, which it must skip.
     *
     * A join snapshot is read from LIVE state, so it already contains the effect of every op waiting
     * in the spill queue — replaying them would spawn a second copy of entities it already holds, and
     * a duplicate spawn is not idempotent. Counted down as each send delivers part of the backlog,
     * never cleared in one go: a spill deeper than one send's budget spans several sends.
     */
    structuralSkip = 0;

    /** Whether this connection is owed the current send: joined, live, and no longer awaiting a `Welcome`. */
    get wantsBroadcast(): boolean {
        return !this.closed && this.player !== null && this.pendingJoin === null;
    }

    /** Runs every disposer once. */
    dispose(): void {
        for (const dispose of this.disposers.splice(0)) dispose();
    }
}

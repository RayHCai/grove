import type { Player } from '@platform/core';
import { createActionStates } from '@platform/core';
import type { ActionStates } from '@platform/core';
import type { Interaction, JoinRequest } from '@platform/protocol';
import type { Transport } from '@platform/transport';
import {
    CONTROL_BUCKET_FRAMES,
    INPUT_BUCKET_FRAMES,
    MAX_ACTION_NAMES,
    RATE_BREACH_CLOSE,
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
 * The frontier is not a high-water mark — either half of the resolved rule alone passes under one.
 */
export class AdmissionState {
    /** -1 = nothing resolved, matching the client's own start. */
    #frontier = -1;
    readonly #resolved = new Set<number>();
    /** seq → `frame.tick - serverTickOnArrival`, for whichever ack resolves it. */
    readonly #headroom = new Map<number, number>();
    /** A seq above the frontier that has not arrived, and the latest tick it can name — datable because seq and tick advance together. */
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

    /** Whether cumulative rate refusals have reached the sustained-breach threshold. */
    get overRateBreachLimit(): boolean {
        return this.#rateRefusals >= RATE_BREACH_CLOSE;
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

    /** Records that `seq` arrived on `serverTick` naming `frameTick`, dating any gap it skipped. */
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

    /** Restarts the stale-hold clock, at join too: a player joining at tick 500 must not be born `holdStaleTicks` silent. */
    noteTraffic(serverTick: number): void {
        this.#lastInputTick = serverTick;
    }

    /** Marks `seq` settled — applied, or definitively rejected; both resolve it. */
    resolve(seq: number): void {
        if (seq <= this.#frontier) return;
        this.#resolved.add(seq);
        this.#gapTickBound.delete(seq);
    }

    /** Abandons every gap seq whose latest possible tick is already out of the past grace. */
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
     * Advances the frontier as far as it is contiguous and reports the ack.
     *
     * The headroom is the earliest input this ack resolved — the tail, not the mean, because a lead
     * sized to the mean drops the tail and a player feels that as occasional unresponsiveness.
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

    /** Spends a token for a `join-request` or `time-sync`, off their own far shallower bucket. */
    takeControlToken(): boolean {
        if (this.#controlTokens <= 0) return false;
        this.#controlTokens--;
        return true;
    }

    /** Whether this connection may still name `action` — the first use of a new name claims a slot. */
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
    /**
     * The stable player id the host named this peer, or null when it named none.
     *
     * Never a wire field: the leave path writes the record back, so one here would be a
     * read-and-overwrite capability over any saved player.
     */
    readonly identity: string | null;
    readonly transport: Transport;
    readonly admission = new AdmissionState();
    /** Disposers from `transport.onMessage` / `onClose`, run once on drop. */
    readonly disposers: (() => void)[] = [];
    /** This connection's folded input, through core's own fold — a second one would diverge. */
    readonly actions: ActionStates = createActionStates();
    /** HUD presses and pointer hits awaiting the next tick pass. */
    readonly interactions: Interaction[] = [];

    /** Null until the first valid `JoinRequest` allocates it. */
    player: Player | null = null;
    /** The `JoinRequest` still owed a `Welcome`, held rather than flagged because only it carries the `clientSentMs` to echo. */
    pendingJoin: JoinRequest | null = null;
    /** True while this connection's persisted record is being read, so a second request cannot race it. */
    admitting = false;
    /** The pump clock reading at `accept`, or null when accepted before the first wake. */
    acceptedAtSeconds: number | null;
    closed = false;

    constructor(
        connectionId: string,
        identity: string | null,
        transport: Transport,
        acceptedAtSeconds: number | null,
    ) {
        this.connectionId = connectionId;
        this.identity = identity;
        this.transport = transport;
        this.acceptedAtSeconds = acceptedAtSeconds;
    }

    get joined(): boolean {
        return this.player !== null;
    }

    /** The Player of a connection that is both live and joined, or null — the one predicate every walk over the registry needs. */
    get livePlayer(): Player | null {
        return this.closed ? null : this.player;
    }

    /** What this connection's Player is keyed by: the host's id when it named one, else the connection's. */
    get playerId(): string {
        return this.identity ?? this.connectionId;
    }

    /** Structural ops still held over from before this connection's snapshot, which it must skip. */
    structuralSkip = 0;

    /** Whether this connection is owed the current send: joined, live, and no longer awaiting a `Welcome`. */
    get wantsBroadcast(): boolean {
        return this.livePlayer !== null && this.pendingJoin === null;
    }

    /** Runs every disposer once. */
    dispose(): void {
        for (const dispose of this.disposers.splice(0)) dispose();
    }
}

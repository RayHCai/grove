// The tick-indexed input buffer, the admission checks, and the pass that applies them.
//
// This is the untrusted, adversarial boundary: everything here is a check the server performs
// because a client's frame cannot be trusted.

import type { DispatchOptions, Player, Runtime } from '@platform/core';
import { entityKey, playerKey } from '@platform/core';
import type { InputFrame, InputPhase } from '@platform/protocol';
import type { Connection, RefusalReason } from './connection.js';
import {
    HORIZON_CLAMP_TICKS,
    futureHorizonTicks,
    holdStaleTicks,
    maxSeqGap,
    pastGraceTicks,
} from './constants.js';

/** The panel-mapped move axes `BaseMovement.fillIntent` reads. */
const MOVE_AXES = ['moveX', 'moveY'] as const;

/** A frame and the connection it arrived on, which is carried rather than re-derived: the connection is the identity. */
export interface BufferedInput {
    readonly conn: Connection;
    readonly frame: InputFrame;
}

/** What admission decided. Every arm resolves the seq — refusals included. */
export type AdmitResult =
    | { kind: 'buffered'; at: number }
    /** Past the horizon but inside the clamp band, so applied at the horizon. */
    | { kind: 'clamped'; at: number }
    | { kind: 'refused'; reason: RefusalReason };

/**
 * Arrivals waiting for their intended tick, keyed by tick.
 *
 * Keyed by tick rather than arrival order because the schedule is what matters: a frame arriving
 * late but naming a future tick is applied on time, so timing is judged on the tick the player
 * pressed rather than on their ping.
 */
export class InputBuffer {
    readonly #byTick = new Map<number, BufferedInput[]>();

    /** Frames waiting, across every tick. */
    get size(): number {
        let n = 0;
        for (const slot of this.#byTick.values()) n += slot.length;
        return n;
    }

    /**
     * Runs the window and rate checks in order and, on success, files the frame under the tick it
     * will be applied on. Identity needs no check: the frame carries no player field.
     */
    admit(conn: Connection, frame: InputFrame, currentTick: number, simRate: number): AdmitResult {
        // At or below the frontier it is already resolved, so no ack could report this one and applying
        // it would re-fire an edge the loop has walked past — a replay, or a late arrival on a lossy
        // channel that `abandonStale` already gave up on. A negative seq falls out here too.
        if (frame.seq <= conn.admission.ackSeq) {
            conn.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-old' };
        }

        // Before noteArrival, which dates one map entry per missing seq: `seq` is untrusted and only
        // range-checked as a safe integer, so an unbounded gap is O(seq) CPU and memory for one
        // frame — spent before the window or the rate ceiling could refuse it. Deliberately not
        // through `#refuse`: resolving a seq this far ahead would drag the frontier with it.
        if (frame.seq > conn.admission.highestSeen + maxSeqGap(simRate)) {
            conn.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-far-future' };
        }

        conn.admission.noteArrival(frame.seq, frame.tick, currentTick);

        const floor = currentTick - pastGraceTicks(simRate);
        const horizon = currentTick + futureHorizonTicks(simRate);

        // Three outcomes, not two. Inside the past grace the frame keeps its own tick and
        // merge-forward applies it late, because applying late beats discarding an edge and edges
        // are not idempotent. Just past the horizon is clamped to it; further out is a
        // buffer-exhaustion attempt. Ordered ahead of the rate limit, which it costs nothing.
        if (frame.tick < floor) return this.#refuse(conn, frame, 'too-old');
        if (frame.tick > horizon + HORIZON_CLAMP_TICKS) {
            return this.#refuse(conn, frame, 'too-far-future');
        }

        if (!conn.admission.takeToken()) return this.#refuse(conn, frame, 'rate');

        const clamped = frame.tick > horizon;
        const at = clamped ? horizon : frame.tick;
        this.#file(at, { conn, frame });
        return clamped ? { kind: 'clamped', at } : { kind: 'buffered', at };
    }

    /**
     * Drains every entry scheduled at or before `tick`, oldest tick first, removing the slots.
     *
     * `drainThrough`, not a per-tick drain, which would leave any slot the loop never asks for
     * sitting in the map forever — admitted, never applied, never reported; the past grace and a
     * shed both produce one. Oldest-tick-first is what preserves press-before-release, which is
     * what makes applying late safe at all.
     */
    drainThrough(tick: number): BufferedInput[] {
        const out: BufferedInput[] = [];
        if (this.#byTick.size === 0) return out;

        const due: number[] = [];
        for (const t of this.#byTick.keys()) if (t <= tick) due.push(t);
        if (due.length > 1) due.sort((a, b) => a - b);
        for (const t of due) {
            const slot = this.#byTick.get(t);
            // Appended one at a time rather than spread: a slot's length is peer-influenced, and
            // spreading a long one exhausts the argument limit.
            if (slot) for (const entry of slot) out.push(entry);
            this.#byTick.delete(t);
        }
        return out;
    }

    /** Forgets a dropped connection's pending frames, so a closed peer dispatches nothing. */
    dropConnection(conn: Connection): void {
        for (const [t, slot] of this.#byTick) {
            const kept = slot.filter((entry) => entry.conn !== conn);
            if (kept.length === 0) this.#byTick.delete(t);
            else this.#byTick.set(t, kept);
        }
    }

    #file(at: number, entry: BufferedInput): void {
        const slot = this.#byTick.get(at);
        if (slot) slot.push(entry);
        else this.#byTick.set(at, [entry]);
    }

    /**
     * A refused frame is resolved, not dropped in silence: the ack advances past it, so the refusal
     * is reported by the ack moving with no second envelope to disagree with it.
     */
    #refuse(conn: Connection, frame: InputFrame, reason: RefusalReason): AdmitResult {
        conn.admission.resolve(frame.seq);
        return { kind: 'refused', reason };
    }
}

/** What the input pass needs from the server, so it can be driven with no transport. */
export interface InputPassContext {
    readonly rt: Runtime;
    readonly buffer: InputBuffer;
    /** Every live connection, joined or not — the pass skips the unjoined itself. */
    connections(): Iterable<Connection>;
}

/**
 * The pass the server installs over core's stub: drain this tick's frames, fold them, and dispatch
 * the three phases.
 *
 * A `hold` handler fires every tick while held while the client sends edges only, so `hold` is a
 * dispatch at simRate that nothing but the tick loop can synthesize. Miss it and every `on: 'hold'`
 * handler silently never fires, which reads as a broken movement system.
 */
export function runInputPass(ctx: InputPassContext, dispatch: DispatchOptions): void {
    const { rt, buffer } = ctx;
    const tick = rt.tick;
    const stale = holdStaleTicks(rt.simRate);

    // One tick boundary per connection before any edge lands: `pressed` / `released` are one tick
    // wide, so last tick's must clear whether or not a frame arrived.
    for (const conn of ctx.connections()) {
        if (conn.joined) conn.actions.advanceTick();
    }

    for (const { conn, frame } of buffer.drainThrough(tick)) {
        if (conn.closed || conn.player === null) continue;
        applyBuffered(rt, conn, frame, dispatch);
    }

    for (const conn of ctx.connections()) {
        const player = conn.player;
        if (conn.closed || player === null) continue;
        const hosts = hostKeys(player);

        // The backstop no client can cover: focus loss synthesizes a release, but a crash, a killed
        // tab or a yanked cable sends nothing, and the synthesized `hold` below would otherwise fire
        // forever on an avatar running into a wall.
        if (tick - conn.admission.lastInputTick >= stale) {
            for (const action of conn.actions.heldActions()) {
                conn.actions.applyEdge({ action, on: 'release' });
                dispatchInput(rt, player, hosts, action, 'release', undefined, dispatch);
            }
            // Axes need neutralizing separately: a `hold` never enters `held`, so the release loop
            // above cannot reach one, and left non-neutral a dead client's avatar runs forever.
            for (const { action } of conn.actions.axisValues()) {
                conn.actions.applyEdge({ action, on: 'hold', value: 0 });
            }
        }

        for (const action of activeActions(conn)) {
            dispatchInput(rt, player, hosts, action, 'hold', conn.actions.axis(action), dispatch);
        }

        // Ahead of movement's own pass: without this `intent` stays zero and no avatar ever moves.
        player.movement?.fillIntent(
            conn.actions.axis(MOVE_AXES[0]),
            conn.actions.axis(MOVE_AXES[1]),
        );
    }
}

/**
 * Every action a synthesized `hold` is owed: held buttons union non-neutral axes.
 *
 * `heldActions()` alone is not enough. An axis reaches the wire as a `hold` sample and a `hold` never
 * enters `held`, so an axis appears in neither the wire dispatch nor a `heldActions()` walk — leaving
 * an `{ on: 'hold' }` handler on a move axis receiving zero dispatches.
 */
function activeActions(conn: Connection): Set<string> {
    const out = new Set(conn.actions.heldActions());
    for (const { action } of conn.actions.axisValues()) out.add(action);
    return out;
}

/**
 * Folds one frame into the connection's action state, dispatches its edges, and resolves its seq.
 *
 * Resolved here, at the apply, which is what makes `ackSeq` mean resolved rather than received: a
 * frame held for a future tick must not be acked before the simulation reflects it, or the client
 * prunes input it would need to replay.
 */
function applyBuffered(
    rt: Runtime,
    conn: Connection,
    frame: InputFrame,
    dispatch: DispatchOptions,
): void {
    const player = conn.player;
    if (player === null) return;
    const hosts = hostKeys(player);
    for (const action of frame.actions) {
        // Dropped per action rather than refusing the frame: a peer past the name cap is out of
        // contract, but a legitimate frame's other actions still deserve to land.
        if (!conn.admission.admitsAction(action.action)) continue;
        conn.actions.applyEdge(action);
        // `hold` is synthesized per tick from the fold, so a sampled hold updates the axis and
        // dispatches nothing of its own — dispatching here too would double-fire it.
        if (action.on === 'hold') continue;
        dispatchInput(
            rt,
            player,
            hosts,
            action.action,
            action.on,
            action.value ?? conn.actions.axis(action.action),
            dispatch,
        );
    }
    conn.admission.resolve(frame.seq);
}

/**
 * Fires one action edge at the player's own hosts.
 *
 * The player comes from the connection, never from the frame: a frame cannot name a player, because
 * the connection already did at join.
 */
function dispatchInput(
    rt: Runtime,
    player: Player,
    hosts: readonly string[],
    action: string,
    phase: InputPhase,
    value: number | undefined,
    dispatch: DispatchOptions,
): void {
    const opts: DispatchOptions = { ...dispatch, phase };
    const ctx = {
        data: {},
        dt: 1 / rt.simRate,
        alive: true,
        player,
        ...(value === undefined ? {} : { value }),
    };

    for (const hostKey of hosts) {
        void rt.dispatcher.dispatch(
            rt.instances.forHost(hostKey),
            'onEvent',
            action,
            hostKey,
            ctx,
            opts,
        );
    }
}

/**
 * The player's host and its avatar's, resolved once per connection per tick.
 *
 * Both receive the edge: a movement script's `@onEvent('jump')` lives on the avatar, while a
 * Player-hosted script's handlers must still fire for a spectating player with no avatar at all.
 */
function hostKeys(player: Player): string[] {
    return player.hasAvatar
        ? [playerKey(player.id), entityKey(player.avatar.entityId)]
        : [playerKey(player.id)];
}

import type { DispatchOptions, EntityId, PointerEdge, Player, Runtime } from '@platform/core';
import { entityKey, playerKey, pointerHit, pressWidget } from '@platform/core';
import { defined } from '@platform/math';
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

/** Arrivals waiting for their intended tick, keyed by tick so timing is judged on the tick the player pressed rather than on their ping. */
export class InputBuffer {
    readonly #byTick = new Map<number, BufferedInput[]>();

    /** Frames waiting, across every tick. */
    get size(): number {
        let n = 0;
        for (const slot of this.#byTick.values()) n += slot.length;
        return n;
    }

    /** Runs the window and rate checks in order and, on success, files the frame under the tick it will be applied on. */
    admit(conn: Connection, frame: InputFrame, currentTick: number, simRate: number): AdmitResult {
        if (frame.seq <= conn.admission.ackSeq) {
            conn.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-old' };
        }

        // Deliberately not through `#refuse`: resolving a seq this far ahead of the window would
        // drag the frontier with it.
        if (frame.seq > conn.admission.highestSeen + maxSeqGap(simRate)) {
            conn.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-far-future' };
        }

        conn.admission.noteArrival(frame.seq, frame.tick, currentTick);

        const floor = currentTick - pastGraceTicks(simRate);
        const horizon = currentTick + futureHorizonTicks(simRate);

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

    /** Drains every entry scheduled at or before `tick`, oldest tick first, removing the slots. */
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

    /** A refused frame is resolved, not dropped in silence: the ack advancing past it IS the refusal report. */
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

/** The pass the server installs over core's stub: drain this tick's frames, fold them, and dispatch the three phases. */
export function runInputPass(ctx: InputPassContext, dispatch: DispatchOptions): void {
    const { rt, buffer } = ctx;
    const tick = rt.tick;
    const stale = holdStaleTicks(rt.simRate);

    for (const conn of ctx.connections()) {
        if (conn.joined) conn.actions.advanceTick();
    }

    for (const { conn, frame } of buffer.drainThrough(tick)) {
        if (conn.livePlayer === null) continue;
        applyBuffered(rt, conn, frame, dispatch);
    }

    for (const conn of ctx.connections()) {
        const player = conn.livePlayer;
        if (player === null) continue;
        const hosts = hostKeys(player);

        if (tick - conn.admission.lastInputTick >= stale) {
            for (const action of conn.actions.heldActions()) {
                conn.actions.applyEdge({ action, on: 'release' });
                dispatchInput(rt, player, hosts, action, 'release', undefined, dispatch);
            }
            // Axes need neutralizing separately: a `hold` never enters `held`, so the release loop
            // above cannot reach one.
            for (const { action } of conn.actions.axisValues()) {
                conn.actions.applyEdge({ action, on: 'hold', value: 0 });
            }
        }

        for (const action of activeActions(conn)) {
            dispatchInput(rt, player, hosts, action, 'hold', conn.actions.axis(action), dispatch);
        }

        player.movement?.fillIntent(
            conn.actions.axis(MOVE_AXES[0]),
            conn.actions.axis(MOVE_AXES[1]),
        );

        drainInteractions(rt, conn, player);
    }
}

/** Dispatches this connection's queued HUD presses and pointer hits, through core's own entry points so no rule is copied. */
function drainInteractions(rt: Runtime, conn: Connection, player: Player): void {
    if (conn.interactions.length === 0) return;
    for (const event of conn.interactions.splice(0)) {
        if (event.kind === 'press') {
            void pressWidget(rt, {
                widget: event.widget,
                ...defined({ screen: event.screen }),
                player,
            });
            continue;
        }
        // A NetId IS the server's EntityId, cast at the boundary; `pointerHit` drops a dead one.
        void pointerHit(rt, POINTER_EDGE[event.kind], event.netId as unknown as EntityId, player);
    }
}

/** The wire's pointer kinds to core's handler kinds. */
const POINTER_EDGE = {
    click: 'onClick',
    'hover-enter': 'onHoverEnter',
    'hover-exit': 'onHoverExit',
} as const satisfies Record<string, PointerEdge>;

/** Every action a synthesized `hold` is owed: held buttons union non-neutral axes, since an axis never enters `held`. */
function activeActions(conn: Connection): Set<string> {
    const out = new Set(conn.actions.heldActions());
    for (const { action } of conn.actions.axisValues()) out.add(action);
    return out;
}

/** Folds one frame into the connection's action state, dispatches its edges, and resolves its seq — at the apply, which is what makes `ackSeq` mean resolved. */
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
        // `hold` is synthesized per tick from the fold, so dispatching here too would double-fire it.
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

/** Fires one action edge at the player's own hosts. */
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
        ...defined({ value }),
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

/** The player's host and its avatar's, both of which receive the edge — a spectator has no avatar at all. */
function hostKeys(player: Player): string[] {
    return player.hasAvatar
        ? [playerKey(player.id), entityKey(player.avatar.entityId)]
        : [playerKey(player.id)];
}

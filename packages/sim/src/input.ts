import type { DispatchOptions, EntityId, PointerEdge, Player, Runtime } from '@platform/core';
import { deliverRequest, entityKey, playerKey, pointerHit, pressWidget } from '@platform/core';
import { defined } from '@platform/math';
import type { InputFrame, InputPhase } from '@platform/protocol';
import type { RefusalReason, Session } from './session.js';
import {
    HORIZON_CLAMP_TICKS,
    futureHorizonTicks,
    holdStaleTicks,
    maxSeqGap,
    pastGraceTicks,
} from './constants.js';

/** The panel-mapped move axes `BaseMovement.fillIntent` reads. */
const MOVE_AXES = ['moveX', 'moveY'] as const;

/** A frame and the session it arrived on, which is carried rather than re-derived: the session is the identity. */
export interface BufferedInput {
    readonly session: Session;
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
    admit(session: Session, frame: InputFrame, currentTick: number, simRate: number): AdmitResult {
        if (frame.seq <= session.admission.ackSeq) {
            session.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-old' };
        }

        // Deliberately not through `#refuse`: resolving a seq this far ahead of the window would
        // drag the frontier with it.
        if (frame.seq > session.admission.highestSeen + maxSeqGap(simRate)) {
            session.admission.noteTraffic(currentTick);
            return { kind: 'refused', reason: 'too-far-future' };
        }

        session.admission.noteArrival(frame.seq, frame.tick, currentTick);

        const floor = currentTick - pastGraceTicks(simRate);
        const horizon = currentTick + futureHorizonTicks(simRate);

        if (frame.tick < floor) return this.#refuse(session, frame, 'too-old');
        if (frame.tick > horizon + HORIZON_CLAMP_TICKS) {
            return this.#refuse(session, frame, 'too-far-future');
        }

        if (!session.admission.takeToken()) return this.#refuse(session, frame, 'rate');

        const clamped = frame.tick > horizon;
        const at = clamped ? horizon : frame.tick;
        this.#file(at, { session, frame });
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

    /** Forgets a dropped session's pending frames, so a closed peer dispatches nothing. */
    dropSession(session: Session): void {
        for (const [t, slot] of this.#byTick) {
            const kept = slot.filter((entry) => entry.session !== session);
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
    #refuse(session: Session, frame: InputFrame, reason: RefusalReason): AdmitResult {
        session.admission.resolve(frame.seq);
        return { kind: 'refused', reason };
    }
}

/** What the input pass needs from the server, so it can be driven with no transport. */
export interface InputPassContext {
    readonly rt: Runtime;
    readonly buffer: InputBuffer;
    /** Every live session, joined or not — the pass skips the unjoined itself. */
    sessions(): Iterable<Session>;
}

/** The pass the server installs over core's stub: drain this tick's frames, fold them, and dispatch the three phases. */
export function runInputPass(ctx: InputPassContext, dispatch: DispatchOptions): void {
    const { rt, buffer } = ctx;
    const tick = rt.tick;
    const stale = holdStaleTicks(rt.simRate);

    for (const session of ctx.sessions()) {
        if (session.joined) session.actions.advanceTick();
    }

    for (const { session, frame } of buffer.drainThrough(tick)) {
        if (session.livePlayer === null) continue;
        applyBuffered(rt, session, frame, dispatch);
    }

    for (const session of ctx.sessions()) {
        const player = session.livePlayer;
        if (player === null) continue;
        const hosts = hostKeys(player);

        if (tick - session.admission.lastInputTick >= stale) {
            for (const action of session.actions.heldActions()) {
                session.actions.applyEdge({ action, on: 'release' });
                dispatchInput(rt, player, hosts, action, 'release', undefined, dispatch);
            }
            // Axes need neutralizing separately: a `hold` never enters `held`, so the release loop
            // above cannot reach one.
            for (const { action } of session.actions.axisValues()) {
                session.actions.applyEdge({ action, on: 'hold', value: 0 });
            }
        }

        for (const action of activeActions(session)) {
            dispatchInput(
                rt,
                player,
                hosts,
                action,
                'hold',
                session.actions.axis(action),
                dispatch,
            );
        }

        player.movement?.fillIntent(
            session.actions.axis(MOVE_AXES[0]),
            session.actions.axis(MOVE_AXES[1]),
        );

        drainInteractions(rt, session, player);
        drainRequests(rt, session, player);
    }
}

/** Dispatches this connection's queued requests, on the authority, with the player the connection names. */
function drainRequests(rt: Runtime, session: Session, player: Player): void {
    if (session.requests.length === 0) return;
    for (const call of session.requests.splice(0)) {
        void deliverRequest(rt, { name: call.name, ...defined({ payload: call.data }), player });
    }
}

/** Dispatches this connection's queued HUD presses and pointer hits, through core's own entry points so no rule is copied. */
function drainInteractions(rt: Runtime, session: Session, player: Player): void {
    if (session.interactions.length === 0) return;
    for (const event of session.interactions.splice(0)) {
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
function activeActions(session: Session): Set<string> {
    const out = new Set(session.actions.heldActions());
    for (const { action } of session.actions.axisValues()) out.add(action);
    return out;
}

/** Folds one frame into the connection's action state, dispatches its edges, and resolves its seq — at the apply, which is what makes `ackSeq` mean resolved. */
function applyBuffered(
    rt: Runtime,
    session: Session,
    frame: InputFrame,
    dispatch: DispatchOptions,
): void {
    const player = session.player;
    if (player === null) return;
    const hosts = hostKeys(player);
    for (const action of frame.actions) {
        // Dropped per action rather than refusing the frame: a peer past the name cap is out of
        // contract, but a legitimate frame's other actions still deserve to land.
        if (!session.admission.admitsAction(action.action)) continue;
        session.actions.applyEdge(action);
        // `hold` is synthesized per tick from the fold, so dispatching here too would double-fire it.
        if (action.on === 'hold') continue;
        dispatchInput(
            rt,
            player,
            hosts,
            action.action,
            action.on,
            action.value ?? session.actions.axis(action.action),
            dispatch,
        );
    }
    session.admission.resolve(frame.seq);
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

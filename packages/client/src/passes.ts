// The client's tick passes: the input fold the server's own pass mirrors, and the narrowing that
// keeps a replayed tick inside the entities this client owns.
//
// Core's table is whole-world — it ignores the `scope` a client step hands it — so the narrowing lives
// here or a remote avatar is extrapolated off input this client never had. The input half must agree
// with `@platform/server`'s pass edge for edge: it cannot be imported (the client never imports the
// server), and a second one-tick-wide rule would read as a prediction bug rather than a copied one.

import type {
    ActionStates,
    DispatchOptions,
    EntityId,
    Player,
    Runtime,
    TickPasses,
} from '@platform/core';
import { activeLocationsFor, entityKey, playerKey, tickMovement } from '@platform/core';
import type { EventPhase } from '@platform/core';
import type { InputFrame } from '@platform/protocol';

/**
 * The panel-mapped move axes `BaseMovement.fillIntent` reads.
 *
 * Restated rather than shared: core names them in no export, and the server's pass holds the same pair.
 */
const MOVE_AXES = ['moveX', 'moveY'] as const;

/** What the client's passes need, resolved per tick because the roster fills after the join. */
export interface ClientPassContext {
    readonly rt: Runtime;
    /** The predicted fold: advanced once per tick, then fed that tick's edges. */
    actions(): ActionStates;
    /** The local player, or null while the roster does not carry them. */
    player(): Player | null;
    /** The entities this client simulates — the local player's own. */
    scope(): ReadonlySet<EntityId>;
    /** The frame stamped with `tick`, or undefined for a tick the player sent nothing on. */
    frameFor(tick: number): InputFrame | undefined;
}

/**
 * The table the mirror installs while it predicts, over the one `loadGame` built.
 *
 * `contacts` and `regions` are both deliberately dropped: each is a consequence of a position this
 * client only predicted, and consequences are the authority's — firing `@onCollide` or `@onEnter`
 * here would apply damage the server has not agreed to. Both also diff against a previous tick that
 * no snapshot store holds, so a rewind would leave the edge describing a tick that was taken back.
 *
 * `countdowns` stays core's: a countdown is host-local display timing with no authoritative
 * counterpart to disagree with, and core's own pass already skips a replayed tick so a re-run
 * cannot spend one twice.
 */
export function clientPasses(base: TickPasses, ctx: ClientPassContext): TickPasses {
    return {
        // Core's, unchanged: a script the wire told this client to attach is owed its `@onStart`
        // on the same pass the authority ran it, and the drain is once-only so a replayed tick
        // cannot spend it twice.
        starts: base.starts,
        input: (dispatch) => runInputPass(ctx, dispatch),
        movement: (dt, scope) => runMovementPass(ctx.rt, dt, scope),
        contacts: () => {},
        regions: () => {},
        countdowns: base.countdowns,
        update: (dispatch, dt, scope) => runUpdatePass(ctx, dispatch, dt, scope),
    };
}

/**
 * Folds this tick's frame, dispatches its edges, and synthesizes the `hold` the wire leaves out.
 *
 * The order is the contract: one `advanceTick` before any edge lands, because `pressed` / `released`
 * are one tick wide and last tick's must clear whether or not a frame arrived; then the edges; then
 * one `hold` per active action, since edges-only input means nothing else can fire an `{ on: 'hold' }`
 * handler; then `fillIntent`, ahead of the movement pass, or `intent` stays zero and nothing moves.
 */
function runInputPass(ctx: ClientPassContext, dispatch: DispatchOptions): void {
    const rt = ctx.rt;
    const player = ctx.player();
    if (player === null) return;
    const actions = ctx.actions();

    actions.advanceTick();

    const hosts = hostKeys(player, ctx.scope());
    const frame = ctx.frameFor(rt.tick);
    if (frame !== undefined) {
        for (const action of frame.actions) {
            actions.applyEdge(action);
            // A sampled hold updates the axis and dispatches nothing of its own: the synthesized one
            // below is the only `hold`, and dispatching here too would double-fire it.
            if (action.on === 'hold') continue;
            dispatchInput(
                rt,
                player,
                hosts,
                action.action,
                action.on,
                action.value ?? actions.axis(action.action),
                dispatch,
            );
        }
    }

    for (const action of activeActions(actions)) {
        dispatchInput(rt, player, hosts, action, 'hold', actions.axis(action), dispatch);
    }

    player.movement?.fillIntent(actions.axis(MOVE_AXES[0]), actions.axis(MOVE_AXES[1]));
}

/**
 * Every action a synthesized `hold` is owed: held buttons union non-neutral axes.
 *
 * `heldActions()` alone is not enough. An axis reaches the wire as a `hold` sample and a `hold` never
 * enters `held`, so an axis appears in neither the frame's dispatch nor a `heldActions()` walk.
 */
function activeActions(actions: ActionStates): Set<string> {
    const out = new Set(actions.heldActions());
    for (const { action } of actions.axisValues()) out.add(action);
    return out;
}

/**
 * The player's own host and every entity they own.
 *
 * The server resolves the second half as the avatar, which this runtime does not have: nothing here
 * fills a `Player`'s avatar, so ownership is the client's only handle on the same entity.
 */
function hostKeys(player: Player, scope: ReadonlySet<EntityId>): string[] {
    const keys = [playerKey(player.id)];
    for (const id of scope) keys.push(entityKey(id as number));
    return keys;
}

/** Fires one action edge at the local player's hosts, exactly as the authority fires it at its own. */
function dispatchInput(
    rt: Runtime,
    player: Player,
    hosts: readonly string[],
    action: string,
    phase: EventPhase,
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

/** Core's movement pass, narrowed: a movement whose host is out of scope belongs to another client. */
function runMovementPass(rt: Runtime, dt: number, scope: ReadonlySet<EntityId> | undefined): void {
    for (const player of rt.playerManager?.players ?? []) {
        const movement = player.movement;
        if (!movement) continue;
        // A destroyed avatar leaves its movement instance live, and the physics sink would otherwise
        // keep writing positions for whatever entity reuses the released slot.
        const host = movement.host as unknown as { entityId: EntityId };
        if (!rt.entities.isAlive(host.entityId)) continue;
        if (scope !== undefined && !scope.has(host.entityId)) continue;
        tickMovement(rt, movement, host.entityId, dt);
    }
}

/**
 * `@onUpdate` for the scoped hosts only.
 *
 * `activeLocationsFor('server')` matches core: a `ClientScript`'s `@onUpdate` is display-rate through
 * `frame()` and must not fire from a sim step, while a `SyncedScript`'s is the tick's to run. Game-hosted
 * scripts are left out — the game is nobody's to predict.
 */
function runUpdatePass(
    ctx: ClientPassContext,
    dispatch: DispatchOptions,
    dt: number,
    scope: ReadonlySet<EntityId> | undefined,
): void {
    const rt = ctx.rt;
    const opts: DispatchOptions = { ...dispatch, activeLocations: activeLocationsFor('server') };

    for (const id of scope ?? ctx.scope()) dispatchUpdate(rt, entityKey(id as number), dt, opts);
    const player = ctx.player();
    if (player !== null) dispatchUpdate(rt, playerKey(player.id), dt, opts);
}

function dispatchUpdate(rt: Runtime, hostKey: string, dt: number, opts: DispatchOptions): void {
    for (const instance of rt.instances.forHost(hostKey)) {
        void rt.dispatcher.dispatch(
            [instance],
            'onUpdate',
            '@update',
            '',
            { data: {}, dt, alive: true },
            opts,
        );
    }
}

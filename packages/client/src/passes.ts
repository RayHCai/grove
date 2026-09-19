// The input fold must match `@platform/sim`'s pass edge for edge; the client never imports the
// server, so the duplication is deliberate. Core's table is whole-world, so narrowing lives here.

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
import { defined } from '@platform/math';
import type { InputFrame } from '@platform/protocol';

/** The panel-mapped move axes `BaseMovement.fillIntent` reads; core exports no name for them. */
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
 * `contacts` and `regions` are dropped: consequences of a predicted position are the authority's.
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
 * Order is the contract: `advanceTick`, edges, one `hold` per active action, then `fillIntent`.
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
            // A sampled hold updates the axis only; the synthesized one below is the only `hold`.
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

/** Every action a synthesized `hold` is owed: held buttons union non-neutral axes. */
function activeActions(actions: ActionStates): Set<string> {
    const out = new Set(actions.heldActions());
    for (const { action } of actions.axisValues()) out.add(action);
    return out;
}

/** The player's own host and every entity they own; ownership is this runtime's only handle. */
function hostKeys(player: Player, scope: ReadonlySet<EntityId>): string[] {
    const keys = [playerKey(player.id)];
    for (const id of scope) keys.push(entityKey(id));
    return keys;
}

/** Fires one action edge at the local player's hosts, as the authority fires at its own. */
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

/** Core's movement pass, narrowed: a movement out of scope belongs to another client. */
function runMovementPass(rt: Runtime, dt: number, scope: ReadonlySet<EntityId> | undefined): void {
    for (const player of rt.playerManager?.players ?? []) {
        const movement = player.movement;
        if (!movement) continue;
        // A destroyed avatar leaves its movement instance live, and the physics sink would keep
        // writing positions for whatever reuses the released slot.
        const host = movement.host as unknown as { entityId: EntityId };
        if (!rt.entities.isAlive(host.entityId)) continue;
        if (scope !== undefined && !scope.has(host.entityId)) continue;
        tickMovement(rt, movement, host.entityId, dt);
    }
}

/** `@onUpdate` for the scoped hosts only; `activeLocationsFor('server')` matches core. */
function runUpdatePass(
    ctx: ClientPassContext,
    dispatch: DispatchOptions,
    dt: number,
    scope: ReadonlySet<EntityId> | undefined,
): void {
    const rt = ctx.rt;
    const opts: DispatchOptions = { ...dispatch, activeLocations: activeLocationsFor('server') };

    for (const id of scope ?? ctx.scope()) dispatchUpdate(rt, entityKey(id), dt, opts);
    const player = ctx.player();
    if (player !== null) dispatchUpdate(rt, playerKey(player.id), dt, opts);
}

function dispatchUpdate(rt: Runtime, hostKey: string, dt: number, opts: DispatchOptions): void {
    const instances = rt.instances.forHost(hostKey);
    for (let i = 0; i < instances.length; i++) {
        const instance = instances[i]!;
        // Ahead of the array and the context, both of which are per-instance: this runs for every
        // scoped entity on every replayed tick, and a replay spans up to MAX_REPLAY_TICKS of them.
        if (!rt.instances.declares(instance, 'onUpdate')) continue;
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

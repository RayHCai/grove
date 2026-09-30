// Core's table is whole-world, so the narrowing to this client's own entities lives here.

import type {
    ActionStates,
    DispatchOptions,
    EntityId,
    Player,
    Runtime,
    TickPasses,
} from '@platform/core';
import {
    activeLocationsFor,
    entityKey,
    foldInputEdges,
    playerKey,
    stepMovements,
    synthesizeHolds,
} from '@platform/core';
import type { InputFrame } from '@platform/protocol';

/** What the client's passes need, resolved per tick because the roster fills after the join. */
export interface ClientPassContext {
    readonly rt: Runtime;
    /** The predicted fold: advanced once per tick, then fed that tick's edges. */
    actions(): ActionStates;
    /** The local player, or null while the roster does not carry them. */
    player(): Player | null;
    /** The entities this client simulates: the local player's own. */
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
        movement: (dt, scope) => stepMovements(ctx.rt, dt, scope),
        contacts: () => {},
        regions: () => {},
        countdowns: base.countdowns,
        update: (dispatch, dt, scope) => runUpdatePass(ctx, dispatch, dt, scope),
    };
}

/** Core's fold, the authority's own: `advanceTick`, this tick's edges, the holds, `fillIntent`. */
function runInputPass(ctx: ClientPassContext, dispatch: DispatchOptions): void {
    const player = ctx.player();
    if (player === null) return;
    const actions = ctx.actions();
    actions.advanceTick();
    const frame = ctx.frameFor(ctx.rt.tick);
    if (frame !== undefined) foldInputEdges(ctx.rt, player, actions, frame.actions, dispatch);
    synthesizeHolds(ctx.rt, player, actions, dispatch);
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

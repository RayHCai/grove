// Both endpoints fold and dispatch input through this one file: the authority applies it and the
// client predicts it, and any difference between the two is a misprediction on every tick.

import type { DispatchOptions } from './dispatch/dispatcher.js';
import type { EntityId } from './ids.js';
import { defined } from '@platform/math';
import type { ActionStates, InputEdge } from './runtime/action-states.js';
import { entityKey, playerKey } from './runtime/hosts.js';
import { tickMovement } from './runtime/movement-pass.js';
import type { Player } from './runtime/player.js';
import type { Runtime } from './runtime/runtime.js';
import type { EventPhase } from './script/types.js';

/** The panel-mapped move axes `BaseMovement.fillIntent` reads. */
export const MOVE_AXES = ['moveX', 'moveY'] as const;

/** The hosts an input edge fires at: the player's own, and its avatar's when it has one. */
export function inputHostKeys(player: Player): string[] {
    return player.hasAvatar
        ? [playerKey(player.id), entityKey(player.avatar.entityId)]
        : [playerKey(player.id)];
}

/** Whether `id` is the entity the roster spawns as `playerId`'s avatar, read off replicated state. */
export function isAvatarOf(rt: Runtime, id: EntityId, playerId: string): boolean {
    const record = rt.entities.record(id);
    return (
        record !== null &&
        record.ownerId === playerId &&
        record.template === rt.wired.roster.avatarTemplate
    );
}

/** Fires one action edge at `hosts`. */
export function dispatchInput(
    rt: Runtime,
    player: Player,
    hosts: readonly string[],
    action: string,
    phase: EventPhase,
    value: number | undefined,
    dispatch: DispatchOptions,
): void {
    const opts: DispatchOptions = { ...dispatch, phase };
    const ctx = { data: {}, dt: 1 / rt.simRate, alive: true, player, ...defined({ value }) };
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

/** Folds each edge and dispatches it; a sampled `hold` updates the axis and dispatches nothing. */
export function foldInputEdges(
    rt: Runtime,
    player: Player,
    actions: ActionStates,
    edges: readonly InputEdge[],
    dispatch: DispatchOptions,
    admits: (action: string) => boolean = () => true,
): void {
    const hosts = inputHostKeys(player);
    for (const edge of edges) {
        if (!admits(edge.action)) continue;
        actions.applyEdge(edge);
        // The per-tick synthesized `hold` is the only one dispatched, or a sampled one double-fires.
        if (edge.on === 'hold') continue;
        dispatchInput(
            rt,
            player,
            hosts,
            edge.action,
            edge.on,
            edge.value ?? actions.axis(edge.action),
            dispatch,
        );
    }
}

/** One synthesized `hold` per held button union non-neutral axis, then the movement intent. */
export function synthesizeHolds(
    rt: Runtime,
    player: Player,
    actions: ActionStates,
    dispatch: DispatchOptions,
): void {
    const hosts = inputHostKeys(player);
    const active = new Set(actions.heldActions());
    for (const { action } of actions.axisValues()) active.add(action);
    for (const action of active) {
        dispatchInput(rt, player, hosts, action, 'hold', actions.axis(action), dispatch);
    }
    player.movement?.fillIntent(actions.axis(MOVE_AXES[0]), actions.axis(MOVE_AXES[1]));
}

/** Ticks every player's movement whose avatar is alive and, given a scope, inside it. */
export function stepMovements(
    rt: Runtime,
    dt: number,
    scope: ReadonlySet<EntityId> | undefined,
): void {
    for (const player of rt.playerManager.players) {
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

import type { EntityId, Player, Runtime } from '@platform/core';
import { GAME_KEY, NO_ENTITY, entityKey, playerKey } from '@platform/core';
import type { EntitySnapshot, StateDiff, StateHostAddr, WorldSnapshot } from '@platform/protocol';
import type { JsonValue } from '@platform/transport';
import { encodeHostField, readEntitySnapshot, readPlayerSnapshot, toNetId } from './broadcast.js';

/**
 * The world as `forPlayer` should first see it, at the current tick.
 *
 * The tick rides here rather than on `Welcome`, so the tick a joiner seeds from cannot disagree with
 * the tick the world it describes was read at.
 */
export function buildSnapshot(rt: Runtime, forPlayer: Player): WorldSnapshot {
    const ids = ancestorsFirst(rt);
    const entities: EntitySnapshot[] = [];
    for (const id of ids) {
        const snapshot = readEntitySnapshot(rt, id);
        if (snapshot !== undefined) entities.push(snapshot);
    }

    return {
        tick: rt.tick,
        entities,
        players: (rt.playerManager?.players ?? []).map(readPlayerSnapshot),
        state: snapshotState(rt, forPlayer, ids),
    };
}

/** Live ids with every parent ahead of its children — a wire requirement, not a convention. */
export function ancestorsFirst(rt: Runtime): EntityId[] {
    const ids = rt.entities.liveIds();
    const live = new Set<number>(ids.map((id) => id as number));
    const children = new Map<number, EntityId[]>();
    const roots: EntityId[] = [];

    for (const id of ids) {
        const parent = rt.entities.record(id)?.parent ?? NO_ENTITY;
        if (parent === NO_ENTITY || !live.has(parent as number)) {
            roots.push(id);
            continue;
        }
        const siblings = children.get(parent as number);
        if (siblings) siblings.push(id);
        else children.set(parent as number, [id]);
    }

    const out: EntityId[] = [];
    const seen = new Set<number>();
    // Iterative and `seen`-guarded: a cycle cannot be built through the creator surface today, but a
    // recursive walk would hang rather than degrade if one ever were.
    const stack = roots.toReversed();
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
        if (seen.has(id as number)) continue;
        seen.add(id as number);
        out.push(id);
        const kids = children.get(id as number);
        if (kids) for (const kid of kids.toReversed()) stack.push(kid);
    }
    for (const id of ids) if (!seen.has(id as number)) out.push(id);
    return out;
}

/** The `@serverState` baseline: all game-record state, this player's own, and every live entity's. */
function snapshotState(rt: Runtime, forPlayer: Player, ids: readonly EntityId[]): StateDiff[] {
    const out: StateDiff[] = [];
    collect(rt, out, GAME_KEY, { kind: 'game' });
    collect(rt, out, playerKey(forPlayer.id), { kind: 'player', id: forPlayer.id });
    for (const id of ids) {
        collect(rt, out, entityKey(id), { kind: 'entity', netId: toNetId(id) });
    }
    return out;
}

/** One entry per host that has any field, so a host with none contributes nothing to the snapshot. */
function collect(rt: Runtime, into: StateDiff[], hostKey: string, host: StateHostAddr): void {
    // `get`, never `ensure`: ensure mints a record for whatever key it is handed, so a walk that used
    // it would create an empty host for every entity it asked about.
    const record = rt.hosts.get(hostKey)?.record;
    if (!record) return;
    const fields: { [field: string]: JsonValue } = {};
    let any = false;
    for (const field of record.values.keys()) {
        const encoded = encodeHostField(record, field);
        if (encoded === undefined) continue;
        fields[field] = encoded;
        any = true;
    }
    if (any) into.push({ host, fields });
}

// The join-time world walk.
//
// A joining client holds nothing and cannot apply a delta against an empty world, so it needs a
// complete picture. Core's channels produce deltas since the last drain and its snapshot form is a
// private simulation rewind — internal store buffers, not a wire format and not scoped to what a
// player may see — so neither gives a join snapshot and this reads live structures instead.
//
// There is deliberately no per-tick mirror behind it: one would pay O(players × dirty) writes every
// tick to serve a read that happens once per join, and delta replication needs per-connection acked
// baselines rather than a mirror — a single current-tick view is the one version no connection is
// behind at.

import type { EntityId, Player, Runtime } from '@platform/core';
import { GAME_KEY, NO_ENTITY, entityKey, playerKey, serializeHostField } from '@platform/core';
import type { EntitySnapshot, StateDiff, StateHostAddr, WorldSnapshot } from '@platform/protocol';
import type { JsonValue } from '@platform/transport';
import { RESERVED_KEYS } from '@platform/transport';
import { encodeStateValue, readEntitySnapshot, readPlayerSnapshot, toNetId } from './broadcast.js';

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

/**
 * Live ids with every parent ahead of its children — a wire requirement, not a convention.
 *
 * A real topological emit rather than core's ascending-slot order, which does not satisfy it:
 * parenting is a post-hoc mutation, so spawning a child, then its parent, then attaching leaves the
 * child in the lower slot, and freelist reuse makes it worse.
 */
export function ancestorsFirst(rt: Runtime): EntityId[] {
    const ids = rt.entities.liveIds();
    const live = new Set<number>(ids.map((id) => id as number));
    const children = new Map<number, EntityId[]>();
    const roots: EntityId[] = [];

    for (const id of ids) {
        const parent = rt.entities.record(id)?.parent ?? NO_ENTITY;
        // A parent that is not live cannot be waited for, so the child is a root — which is what the
        // client would do with it anyway, and better than omitting it.
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
    while (stack.length > 0) {
        const id = stack.pop() as EntityId;
        if (seen.has(id as number)) continue;
        seen.add(id as number);
        out.push(id);
        const kids = children.get(id as number);
        if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as EntityId);
    }
    // Anything a cycle stranded still ships, after the reachable set.
    for (const id of ids) if (!seen.has(id as number)) out.push(id);
    return out;
}

/**
 * The `@serverState` baseline: all game-record state, this player's own, and every live entity's.
 *
 * Per-player scoped, because a field on a Player host replicates to that player alone. The entity
 * third is owed a baseline too: entity state is a channel the steady-state path modifies, so without
 * it an entity-hosted field exists for everyone connected when it was written and for nobody who
 * joins after.
 */
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
        if (RESERVED_KEYS.has(field)) continue;
        // The same read the per-tick diff uses, so a wrapper reaches a joiner in the form the
        // steady-state path would have sent it — the baseline and the delta cannot disagree.
        const encoded = encodeStateValue(serializeHostField(record, field));
        if (encoded === undefined) continue;
        fields[field] = encoded;
        any = true;
    }
    if (any) into.push({ host, fields });
}

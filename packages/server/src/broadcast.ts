// The drain and the fan-out: three channels to two envelopes, with no structure between them.
//
// The drain happens once and the broadcast fans it out. Each drain clears what it consumes, so it
// cannot be run per connection — the first would take the marks and the rest would get nothing. The
// resulting set lives for one send and is not state the server carries between ticks.

import type { EntityId, HostRecord, Runtime, StateMark, StructuralOp } from '@platform/core';
import { Entity, GAME_KEY, NO_ENTITY, Player, entityKey, playerKey } from '@platform/core';
import type {
    EntitySnapshot,
    NetId,
    PlayerSnapshot,
    ServerToClient,
    PlayerId,
    StateDiff,
    StateEnvelope,
    StateHostAddr,
    TransformDiff,
    TransformEnvelope,
    WireStructuralOp,
    WireTransform,
} from '@platform/protocol';
import type { Codec, EncodedFrame, JsonValue, Message, Transport } from '@platform/transport';
import type { Connection } from './connection.js';
import { MAX_STATE_DEPTH } from './constants.js';

/** Speech bubbles ride a `tag` op that is not in core's tag index, so it is filtered here. */
const SAY_PREFIX = 'say:';

/**
 * Numerically a `NetId` is the server's `EntityId`, so this needs no map and the one in the system is
 * the client's. The double cast is required, not sloppy: each brand keys off its own `unique symbol`.
 */
export function toNetId(id: EntityId): NetId {
    return id as number as NetId;
}

/** The seven transform fields in core's own declaration order. A read, never a write. */
export function readTransform(rt: Runtime, id: EntityId): WireTransform {
    return {
        posX: finite(rt.transforms.posX(id), 0),
        posY: finite(rt.transforms.posY(id), 0),
        posZ: finite(rt.transforms.posZ(id), 0),
        rot: finite(rt.transforms.rotation(id), 0),
        scale: finite(rt.transforms.scale(id), 1),
        opacity: finite(rt.transforms.opacity(id), 1),
        layer: finite(rt.transforms.layer(id), 0),
    };
}

/**
 * Degrades a non-finite cell to the store's own slot default rather than letting it reach the codec.
 *
 * Core guards nothing — `setPosition(NaN)` writes straight into the `Float64Array` — and the codec
 * refuses `NaN`, which would abort the fan-out for every connection and then repeat on every send.
 */
function finite(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * One entity as a joiner or a spawn must receive it.
 *
 * `hierarchy: false` is the spawn form: core's `create` sets neither parent nor tags, so both arrive as
 * their own later ops. Filling them from live state would describe the entity as it is at drain time
 * while the ops that got it there are still to come, so the client would re-apply a known reparent.
 */
export function readEntitySnapshot(
    rt: Runtime,
    id: EntityId,
    opts: { hierarchy: boolean } = { hierarchy: true },
): EntitySnapshot | undefined {
    const record = rt.entities.record(id);
    if (!record) return undefined;
    const parent = opts.hierarchy && record.parent !== NO_ENTITY ? toNetId(record.parent) : null;
    return {
        netId: toNetId(id),
        template: record.template,
        parent,
        owner: record.ownerId === '' ? null : record.ownerId,
        // A mutable copy: the wire boundary refuses a `readonly` array.
        tags: opts.hierarchy ? [...rt.tags.tagsOf(id)] : [],
        transform: readTransform(rt, id),
    };
}

/** One player as a joiner must receive it, with the roster-assigned index. */
export function readPlayerSnapshot(player: Player): PlayerSnapshot {
    return { id: player.id, index: player.index, name: player.name };
}

/**
 * Everything one send-tick drains, before it is fanned out.
 *
 * `state` is partitioned rather than flat because a `@serverState` field on a Player host replicates
 * to that player alone, so scoping has to survive the drain to be applied at the fan-out.
 */
export interface SendSet {
    tick: number;
    structural: WireStructuralOp[];
    /** Game- and entity-hosted marks: every connection sees these verbatim. */
    sharedState: StateDiff[];
    /** playerId → that player's own marks, and no one else's. */
    playerState: Map<PlayerId, StateDiff[]>;
    transform: TransformDiff[];
    /** Marks and ops dropped as unrepresentable, so a silent loss is visible. */
    dropped: number;
    /** The shared frame's one encode, memoised across the fan-out. Null until first sent. */
    encodedTransform: EncodedFrame | null;
}

/** Roster ops the server synthesizes, since core's journal has no arm for either. */
export interface RosterOps {
    /** Prepended: a join must precede the spawns its own handler produced. */
    joins: PlayerSnapshot[];
    /** Appended: a leave must follow the destroys of that player's owned entities. */
    leaves: string[];
}

/**
 * Drains all three channels exactly once and assembles the send set.
 *
 * Nothing else drains them on the server, so there is no double-drain hazard. Draining is also what
 * meets core's replication-sink obligation: core marks the right channel, the sink decides cadence.
 */
export function drainOnce(rt: Runtime, tick: number, roster: RosterOps): SendSet {
    const set: SendSet = {
        tick,
        structural: [],
        sharedState: [],
        playerState: new Map(),
        transform: [],
        dropped: 0,
        encodedTransform: null,
    };

    for (const snapshot of roster.joins) {
        set.structural.push({ kind: 'player-join', player: snapshot });
    }

    const journal = rt.channels.drainStructural();
    const ephemeral = ephemeralIds(rt, journal);
    for (const op of journal) {
        const wire = toWireStructural(rt, op, ephemeral);
        if (wire === undefined) set.dropped += 1;
        else set.structural.push(wire);
    }

    for (const id of roster.leaves) {
        set.structural.push({ kind: 'player-leave', id });
    }

    // consumeDirty returns dirty slot indices — which entities moved, not what they moved to — so
    // the current transform is read per index and one whole-transform diff emitted.
    for (const index of rt.transforms.consumeDirty()) {
        const id = rt.entities.idAt(index);
        if (id === NO_ENTITY) continue; // a released slot; releaseSlot already clears its bit
        set.transform.push({ ...readTransform(rt, id), netId: toNetId(id) });
    }

    // Built on the first mark, never unconditionally: the table walks every live entity, and a send
    // interval with no state writes is the common case.
    let hosts: Map<string, StateHostAddr> | null = null;
    // One bucket per host, so an entity that wrote four fields names its address once. Keyed by
    // core's own host key, which is the host identity the mark already carries.
    const shared = new Map<string, StateDiff>();
    const perPlayer = new Map<PlayerId, StateDiff>();
    for (const mark of rt.channels.drainState()) {
        hosts ??= hostAddresses(rt);
        const write = toStateWrite(mark, hosts);
        if (write === undefined) {
            set.dropped += 1;
            continue;
        }
        const { host, hostKey, field, value } = write;
        const bucket =
            host.kind === 'player'
                ? (perPlayer.get(host.id) ?? put(perPlayer, host.id, { host, fields: {} }))
                : (shared.get(hostKey) ?? put(shared, hostKey, { host, fields: {} }));
        bucket.fields[field] = value;
    }
    set.sharedState = [...shared.values()];
    for (const [id, diff] of perPlayer) set.playerState.set(id, [diff]);

    return set;
}

/**
 * Ids spawned and released inside this one journal, whose ops are dropped as a pair.
 *
 * A released entity has no record for the spawn's snapshot to read, so its template would go out as
 * `''` and abort the client's whole reconcile — and an entity that lived less than one send interval is
 * gone by the time the client hears of it anyway.
 */
function ephemeralIds(rt: Runtime, journal: readonly StructuralOp[]): Set<number> {
    const gone = new Set<number>();
    for (const op of journal) {
        if (op.kind === 'spawn' && rt.entities.record(op.id) === null) gone.add(op.id as number);
    }
    return gone;
}

function toWireStructural(
    rt: Runtime,
    op: StructuralOp,
    ephemeral: Set<number>,
): WireStructuralOp | undefined {
    if (ephemeral.has(op.id as number)) return undefined;
    switch (op.kind) {
        case 'spawn': {
            const snapshot = readEntitySnapshot(rt, op.id, { hierarchy: false });
            return snapshot === undefined ? undefined : { kind: 'spawn', snapshot };
        }
        case 'destroy':
            return { kind: 'destroy', netId: toNetId(op.id) };
        case 'reparent':
            // NO_ENTITY is how core spells a detach and `null` is how the wire does; the client's
            // applier branches on exactly this.
            return {
                kind: 'reparent',
                netId: toNetId(op.id),
                parent: op.parent === NO_ENTITY ? null : toNetId(op.parent),
            };
        case 'tag':
            // A say tag is a real op that is not in core's tag index, so passing it through would
            // leave the client's tag set and its queries disagreeing with the server's.
            if (op.tag.startsWith(SAY_PREFIX)) return undefined;
            return { kind: 'tag', netId: toNetId(op.id), tag: op.tag, added: op.added };
        case 'attach':
            return { kind: 'attach', netId: toNetId(op.id), scriptClass: op.scriptClass };
    }
}

/**
 * hostId → the wire address for it, built forward from the hosts that exist rather than by parsing a
 * key: a core rename becomes a compile error, and a mark naming a dead host misses the table and is
 * dropped rather than addressed at a host the client cannot resolve.
 */
function hostAddresses(rt: Runtime): Map<string, StateHostAddr> {
    const table = new Map<string, StateHostAddr>();
    table.set(GAME_KEY, { kind: 'game' });
    for (const player of rt.playerManager?.players ?? []) {
        table.set(playerKey(player.id), { kind: 'player', id: player.id });
    }
    for (const id of rt.entities.liveIds()) {
        table.set(entityKey(id), { kind: 'entity', netId: toNetId(id) });
    }
    return table;
}

function put<K, V>(into: Map<K, V>, key: K, value: V): V {
    into.set(key, value);
    return value;
}

/**
 * Field names a grouped diff cannot carry, so they are dropped and counted like an unrepresentable
 * value. Assigning one would set the bucket's prototype instead of adding a key, and the codec
 * refuses the key on the way out regardless.
 */
export const RESERVED_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function toStateWrite(
    mark: StateMark,
    hosts: Map<string, StateHostAddr>,
): { host: StateHostAddr; hostKey: string; field: string; value: JsonValue } | undefined {
    const record = mark.record as HostRecord;
    const host = hosts.get(record.hostId);
    if (host === undefined) return undefined;
    if (RESERVED_FIELDS.has(mark.field)) return undefined;
    const value = encodeStateValue(record.values.get(mark.field));
    // The codec throws on `undefined`, so one unrepresentable field would abort the whole send for
    // every connection. Dropped and counted instead.
    if (value === undefined) return undefined;
    return { host, hostKey: record.hostId, field: mark.field, value };
}

/**
 * A `@serverState` value as JSON, or `undefined` for "not representable", which the caller drops and
 * counts. The host record holds values raw and the codec rejects a class instance, so a ref travels as
 * what identifies it across the wire.
 */
export function encodeStateValue(
    value: unknown,
    open: Set<object> = new Set(),
    depth = 0,
): JsonValue | undefined {
    if (value === null) return null;
    switch (typeof value) {
        case 'number':
            return Number.isFinite(value) ? value : undefined;
        case 'string':
        case 'boolean':
            return value;
        case 'object':
            break;
        default:
            return undefined;
    }
    if (value instanceof Entity) return toNetId(value.entityId) as number;
    if (value instanceof Player) return value.id;

    // A cycle would recurse until the stack blew, and that RangeError aborts the send for every
    // connection — the failure the drop-and-count contract exists to prevent. `open` is an ancestor
    // set, deleted on the way out, so a DAG stays legal exactly as it is on the wire.
    if (open.has(value) || depth >= MAX_STATE_DEPTH) return undefined;
    open.add(value);
    try {
        if (Array.isArray(value)) {
            const out: JsonValue[] = [];
            for (const item of value) {
                const encoded = encodeStateValue(item, open, depth + 1);
                if (encoded === undefined) return undefined;
                out.push(encoded);
            }
            return out;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
        const out: { [key: string]: JsonValue } = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const encoded = encodeStateValue(item, open, depth + 1);
            if (encoded === undefined) return undefined;
            out[key] = encoded;
        }
        return out;
    } finally {
        open.delete(value);
    }
}

/**
 * One connection's pair of envelopes, reliable first — the client holds a transform envelope until the
 * state envelope for its tick has been applied.
 *
 * The transform envelope is the shared subset until interest management lands, so it is encoded lazily
 * and memoised on the set: a fan-out over N connections pays exactly one `encode`, even though the
 * server drives it connection by connection to skip the peers still awaiting a `Welcome`.
 *
 * No try/catch: `send` / `sendEncoded` after a peer's `close()` are silent no-ops, so one peer dropping
 * between the step and the send cannot abort the fan-out over the others.
 */
export function broadcastTo(conn: Connection, set: SendSet, codec: Codec): void {
    const player = conn.player;
    if (conn.closed || player === null) return;
    sendState(conn, player, set);
    conn.transport.sendEncoded(encodedTransform(set, codec));
}

function encodedTransform(set: SendSet, codec: Codec): EncodedFrame {
    if (set.encodedTransform === null) {
        const frame: TransformEnvelope = {
            kind: 'transform',
            tick: set.tick,
            transform: set.transform,
        };
        set.encodedTransform = codec.encode(frame as unknown as Message);
    }
    return set.encodedTransform;
}

/** Builds and sends one connection's reliable envelope — the per-connection residue. */
function sendState(conn: Connection, player: Player, set: SendSet): void {
    const ack = conn.admission.takeAck();
    const scoped = set.playerState.get(player.id);
    const envelope: StateEnvelope = {
        kind: 'state',
        tick: set.tick,
        ackSeq: ack.ackSeq,
        structural: set.structural,
        state: scoped === undefined ? set.sharedState : [...set.sharedState, ...scoped],
    };
    // Absent when this ack resolved no input, never explicitly `undefined` — the codec refuses the
    // latter, because `JSON.stringify` would silently drop it.
    if (ack.earliestHeadroom !== undefined) envelope.earliestHeadroom = ack.earliestHeadroom;
    send(conn.transport, envelope);
}

/**
 * The one place a server envelope reaches the wire.
 *
 * Typed as the union rather than `object`, so an envelope that is not one of protocol's own cannot reach
 * a peer; the cast is only there because an envelope declared as a `type` has no index signature.
 */
export function send(transport: Transport, envelope: ServerToClient): void {
    transport.send(envelope as unknown as Message);
}

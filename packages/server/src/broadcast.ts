import type {
    EntityId,
    HostRecord,
    Runtime,
    SingleStructuralOp,
    StructuralOp,
} from '@platform/core';
import {
    Entity,
    GAME_KEY,
    NO_ENTITY,
    Player,
    entityKey,
    playerKey,
    serializeHostField,
} from '@platform/core';
import { defined } from '@platform/math';
import type { ScriptId, TemplateId } from '@platform/project';
import type {
    EntityOverrides,
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
    WireScriptAttachment,
    WireSingleStructuralOp,
    WireStructuralOp,
    WireTransform,
} from '@platform/protocol';
import { finiteOr } from '@platform/math';
import type { Codec, EncodedFrame, JsonValue, Message, Transport } from '@platform/transport';
import { RESERVED_KEYS } from '@platform/transport';
import type { Connection } from './connection.js';
import { MAX_STATE_DEPTH } from './constants.js';

/** Speech bubbles ride a `tag` op that is not in core's tag index, so it is filtered here. */
const SAY_PREFIX = 'say:';

/** A `NetId` numerically IS the server's `EntityId`; the double cast is required because each brand keys off its own `unique symbol`. */
export function toNetId(id: EntityId): NetId {
    return id as number as NetId;
}

/** The seven transform fields in core's own declaration order, non-finite cells degraded to slot defaults. A read, never a write. */
export function readTransform(rt: Runtime, id: EntityId): WireTransform {
    return {
        posX: finiteOr(rt.transforms.posX(id), 0),
        posY: finiteOr(rt.transforms.posY(id), 0),
        posZ: finiteOr(rt.transforms.posZ(id), 0),
        rot: finiteOr(rt.transforms.rotation(id), 0),
        scale: finiteOr(rt.transforms.scale(id), 1),
        opacity: finiteOr(rt.transforms.opacity(id), 1),
        layer: finiteOr(rt.transforms.layer(id), 0),
    };
}

/** One entity as a joiner or a spawn must receive it; `hierarchy: false` is the spawn form. */
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
        // Cast at the boundary: core's record holds whatever key `spawn` was handed, and the wire's
        // is the authoring id the manifest declared.
        template: record.template as TemplateId,
        parent,
        owner: record.ownerId === '' ? null : record.ownerId,
        // A mutable copy: the wire boundary refuses a `readonly` array.
        tags: opts.hierarchy ? [...rt.tags.tagsOf(id)] : [],
        transform: readTransform(rt, id),
        ...(opts.hierarchy ? overridesOf(rt, id) : {}),
    };
}

/** The scripts on one entity as a joiner needs them, read back off the instance registry rather than the template — absent when it carries none. */
function overridesOf(rt: Runtime, id: EntityId): { overrides?: EntityOverrides } {
    const scripts: WireScriptAttachment[] = [];
    for (const instance of rt.instances.forHost(entityKey(id as number))) {
        const script: ScriptId | undefined = rt.scriptIdOf?.(instance.klass);
        if (script === undefined) continue;
        scripts.push({
            script,
            ...defined({ props: instance.props }),
        });
    }
    return scripts.length === 0 ? {} : { overrides: { scripts } };
}

/** One player as a joiner must receive it, with the roster-assigned index. */
export function readPlayerSnapshot(player: Player): PlayerSnapshot {
    return { id: player.id, index: player.index, name: player.name };
}

/** Everything one send-tick drains, before it is fanned out; `state` is partitioned because scoping has to survive the drain. */
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
    /**
     * Marks whose host was gone by the time the send drained them.
     *
     * Counted apart from `dropped` because it is ordinary churn, not a defect: a script writes a
     * field and the entity or player it lives on dies inside the same send interval. Folding the two
     * together left `dropped` nonzero for every world that destroys anything, which is what a health
     * signal cannot be.
     */
    staleMarks: number;
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

/** Drains all three channels exactly once and assembles the send set — nothing else drains them on the server. */
export function drainOnce(
    rt: Runtime,
    tick: number,
    roster: RosterOps,
    spill: WireStructuralOp[],
    budget: number,
): SendSet {
    const set: SendSet = {
        tick,
        structural: [],
        sharedState: [],
        playerState: new Map(),
        transform: [],
        dropped: 0,
        staleMarks: 0,
        encodedTransform: null,
    };

    const ordered: WireStructuralOp[] = spill.splice(0);

    for (const snapshot of roster.joins) {
        ordered.push({ kind: 'player-join', player: snapshot });
    }

    // Converted to wire form HERE, before any of it can be held over: a spawn's snapshot is read from
    // live state, and an entity destroyed while its op waited would go out with an empty template.
    const journal = rt.channels.drainStructural();
    const ephemeral = ephemeralIds(rt, journal);
    for (const op of journal) {
        const wire = toWireStructural(rt, op, ephemeral);
        if (wire === undefined) set.dropped += 1;
        else ordered.push(wire);
    }

    for (const id of roster.leaves) {
        ordered.push({ kind: 'player-leave', id });
    }

    const cut = budgetCut(ordered, budget);
    if (cut < ordered.length) {
        set.structural = ordered.slice(0, cut);
        spill.push(...ordered.slice(cut));
    } else {
        set.structural = ordered;
    }

    for (const index of rt.transforms.consumeDirty()) {
        const id = rt.entities.idAt(index);
        if (id === NO_ENTITY) continue; // a released slot; releaseSlot already clears its bit
        set.transform.push({ ...readTransform(rt, id), netId: toNetId(id) });
    }

    // Built on the first mark, never unconditionally: the table walks every live entity, and a send
    // interval with no state writes is the common case.
    let hosts: Map<string, StateHostAddr> | null = null;
    const shared = new Map<string, StateDiff>();
    const perPlayer = new Map<PlayerId, StateDiff>();
    for (const mark of rt.channels.drainState()) {
        hosts ??= hostAddresses(rt);
        const record = mark.record as HostRecord;
        const host = hosts.get(record.hostId);
        // The table is built from the live world, so a miss is a host that died between the write
        // and this drain — the entity's own destroy op already tells every peer.
        if (host === undefined) {
            set.staleMarks += 1;
            continue;
        }
        const value = encodeHostField(record, mark.field);
        if (value === undefined) {
            set.dropped += 1;
            continue;
        }
        const hostKey = record.hostId;
        const field = mark.field;
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

/** How many ops fit in this send, counting a group by what it holds rather than as one. */
function budgetCut(ordered: readonly WireStructuralOp[], budget: number): number {
    let weight = 0;
    for (const [index, op] of ordered.entries()) {
        weight += op.kind === 'group' ? op.ops.length : 1;
        if (weight > budget) return index === 0 ? 1 : index;
    }
    return ordered.length;
}

/** Ids spawned and released inside this one journal, whose ops are dropped as a pair. */
function ephemeralIds(rt: Runtime, journal: readonly StructuralOp[]): Set<number> {
    const gone = new Set<number>();
    for (const op of journal) {
        for (const single of op.kind === 'group' ? op.ops : [op]) {
            if (single.kind === 'spawn' && rt.entities.record(single.id) === null) {
                gone.add(single.id as number);
            }
        }
    }
    return gone;
}

function toWireStructural(
    rt: Runtime,
    op: StructuralOp,
    ephemeral: Set<number>,
): WireStructuralOp | undefined {
    if (op.kind !== 'group') return toWireSingle(rt, op, ephemeral);
    const ops: WireSingleStructuralOp[] = [];
    for (const single of op.ops) {
        const wire = toWireSingle(rt, single, ephemeral);
        if (wire !== undefined) ops.push(wire);
    }
    const only = ops[0];
    if (only === undefined) return undefined;
    return ops.length === 1 ? only : { kind: 'group', ops };
}

function toWireSingle(
    rt: Runtime,
    op: SingleStructuralOp,
    ephemeral: Set<number>,
): WireSingleStructuralOp | undefined {
    if (ephemeral.has(op.id as number)) return undefined;
    switch (op.kind) {
        case 'spawn': {
            const snapshot = readEntitySnapshot(rt, op.id, { hierarchy: false });
            return snapshot === undefined ? undefined : { kind: 'spawn', snapshot };
        }
        case 'destroy':
            return { kind: 'destroy', netId: toNetId(op.id) };
        case 'reparent':
            return {
                kind: 'reparent',
                netId: toNetId(op.id),
                parent: op.parent === NO_ENTITY ? null : toNetId(op.parent),
            };
        case 'tag':
            if (op.tag.startsWith(SAY_PREFIX)) return undefined;
            return { kind: 'tag', netId: toNetId(op.id), tag: op.tag, added: op.added };
        case 'attach':
            return {
                kind: 'attach',
                netId: toNetId(op.id),
                script: op.script,
                ...defined({ props: op.props }),
            };
        default: {
            // `noImplicitReturns` is off, so without this a new arm would return `undefined` and be
            // silently counted as an unrepresentable op.
            const unreachable: never = op;
            return unreachable;
        }
    }
}

/** hostId → its wire address, built forward from the hosts that exist rather than by parsing a key, so a core rename becomes a compile error. */
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
 * One `@serverState` field as JSON, or `undefined` for "not representable", which the caller drops —
 * the one read both the join baseline and the per-tick delta go through, so neither can keep a field
 * the other discards.
 *
 * Through core's `serializeHostField`, because a wrapper field's value IS the wrapper and no codec
 * represents a class instance. A reserved key is refused here too: the grouped diff makes the name a
 * KEY, so assigning one would set the bucket's prototype instead of adding a member.
 */
export function encodeHostField(record: HostRecord, field: string): JsonValue | undefined {
    if (RESERVED_KEYS.has(field)) return undefined;
    return encodeStateValue(serializeHostField(record, field));
}

/** A `@serverState` value as JSON, or `undefined` for "not representable"; a ref travels as what identifies it across the wire. */
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

    // `open` is an ancestor set, deleted on the way out, so a DAG stays legal exactly as it is on
    // the wire while a cycle is refused before the recursion blows the stack.
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
            if (RESERVED_KEYS.has(key)) return undefined;
            const encoded = encodeStateValue(item, open, depth + 1);
            if (encoded === undefined) return undefined;
            out[key] = encoded;
        }
        return out;
    } finally {
        open.delete(value);
    }
}

/** One connection's pair of envelopes, reliable first — the client holds a transform envelope until the state envelope for its tick has been applied. */
export function broadcastTo(conn: Connection, set: SendSet, codec: Codec): void {
    const player = conn.livePlayer;
    if (player === null) return;
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
    const skip = Math.min(conn.structuralSkip, set.structural.length);
    if (skip > 0) conn.structuralSkip -= skip;
    const envelope: StateEnvelope = {
        kind: 'state',
        tick: set.tick,
        ackSeq: ack.ackSeq,
        structural: skip === 0 ? set.structural : set.structural.slice(skip),
        state: scoped === undefined ? set.sharedState : [...set.sharedState, ...scoped],
    };
    if (ack.earliestHeadroom !== undefined) envelope.earliestHeadroom = ack.earliestHeadroom;
    send(conn.transport, envelope);
}

/** The one place a server envelope reaches the wire; the cast is only there because an envelope declared as a `type` has no index signature. */
export function send(transport: Transport, envelope: ServerToClient): void {
    transport.send(envelope as unknown as Message);
}

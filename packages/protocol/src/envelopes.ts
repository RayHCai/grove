// Every envelope must stay assignable to transport's `JsonValue`: declared `type` and never
// `interface` (an interface gets no implicit index signature), no `readonly` field or array, and an
// optional field means the key is ABSENT rather than explicitly `undefined`.

import type { JsonValue } from '@platform/transport';
import type { NetId, PlayerId } from './ids.js';

/** Everything the server may send — the authoritative list for this direction. */
export type ServerToClient =
    Welcome | Reject | StateEnvelope | TransformEnvelope | TimeSyncReply | RateChange;

/** Everything a client may send — the authoritative list for this direction. */
export type ClientToServer = JoinRequest | InputFrame | TimeSync;

/** Either direction, for code that handles a frame before it knows which way it came. */
export type Envelope = ServerToClient | ClientToServer;

/** The discriminant every envelope carries. */
export type EnvelopeKind = Envelope['kind'];

/** Client → server, the first frame on a connection. */
export type JoinRequest = {
    kind: 'join-request';
    /** A mismatch is a clean refusal, not a decode error. */
    protocolVersion: number;
    /** Untrusted — the server sanitizes and may replace it. */
    name: string;
    /** Client wall-clock at send, echoed in the welcome so one RTT is measurable at join. */
    clientSentMs: number;
    /** Reconnect rebind; a reconnect path must OMIT the key rather than pass `undefined`. */
    token?: string;
};

/** Server → one client, once, in reply. It carries what a joiner cannot guess and nothing else. */
export type Welcome = {
    kind: 'welcome';
    protocolVersion: number;
    yourPlayerId: PlayerId;
    yourPlayerIndex: number;

    /** Fixed timestep and broadcast cadence. Panel-authored, so the client cannot assume 60/20. */
    simRate: number;
    sendRate: number;

    /**
     * The world's fixed extent and its named regions — build-time constants a joiner can no more
     * guess than the two rates, and a client that defaulted them answers region queries wrongly.
     */
    bounds: WireBounds;
    regions: WireRegion[];

    /** Echoed from the JoinRequest, plus the server's own stamp — one RTT sample. */
    clientSentMs: number;
    serverSentMs: number;

    /**
     * A full picture, not a delta. The tick rides here rather than on a field of its own, so the
     * tick a joiner seeds from and the tick its initial world describes cannot disagree.
     */
    snapshot: WorldSnapshot;
    /** What the renderer needs to draw a netId at all. */
    visuals: RenderManifest;

    /** Opaque; presented on a later connect() to rebind. Unused in MVP — omitted, not `undefined`. */
    reconnectToken?: string;
};

/**
 * Server → client instead of a `Welcome`, immediately before `close()`.
 *
 * A refusal with no envelope reaches the client as a bare socket close, indistinguishable from a
 * dropped connection — and the correct responses invert: a drop should retry, a version mismatch
 * must never retry.
 */
export type Reject = {
    kind: 'reject';
    reason: RejectReason;
    /** What the server speaks, so the client can say "update the game" rather than "try again". */
    serverProtocolVersion: number;
};

/** Coarse on purpose: finer detail belongs in a log, not on a wire an unauthenticated peer reaches. */
export type RejectReason = 'version' | 'full';

/**
 * Server → client, every send-tick. RELIABLE — every op must arrive, in order.
 *
 * Sent even when both arrays are empty, because a `TransformEnvelope` is held until the
 * `StateEnvelope` for its tick has been applied.
 */
export type StateEnvelope = {
    kind: 'state';
    tick: number;
    /** Highest contiguous RESOLVED seq for THIS connection. */
    ackSeq: number;
    /**
     * Spare ticks the EARLIEST input this ack resolved had on arrival
     * (`frame.tick - serverTickOnArrival`) — the earliest rather than the mean, because a lead
     * sized to the mean drops the tail, which a player feels as occasional unresponsiveness.
     *
     * ABSENT when this ack resolved no input, never `undefined`; a client that receives no sample
     * holds its current lead.
     */
    earliestHeadroom?: number;
    /** Ordered journal, applied verbatim — the ops do not commute, and a dropped op is unrecoverable. */
    structural: WireStructuralOp[];
    /** One entry per host with writes this tick, scoped to this connection's player. */
    state: StateDiff[];
};

/**
 * Server → client, every send-tick. DROPPABLE — superseded by the next by construction.
 *
 * Split from `StateEnvelope` because a bundle can only ever be sent reliably, and it is the split
 * that makes the server's backpressure policy expressible as "drop this envelope".
 */
export type TransformEnvelope = {
    kind: 'transform';
    /** The tick of the `StateEnvelope` it accompanies — an equality, and the join key. */
    tick: number;
    transform: TransformDiff[];
};

/** One entry in the ordered structural journal. */
export type WireStructuralOp =
    | { kind: 'spawn'; snapshot: EntitySnapshot }
    | { kind: 'destroy'; netId: NetId }
    | { kind: 'reparent'; netId: NetId; parent: NetId | null }
    | { kind: 'tag'; netId: NetId; tag: string; added: boolean }
    /** Distinct from spawn/destroy: an entity leaving a client's view is still alive on the server. */
    | { kind: 'enter-interest'; snapshot: EntitySnapshot }
    | { kind: 'leave-interest'; netId: NetId }
    /** Carries the roster because nothing else on the wire names a player. */
    | { kind: 'player-join'; player: PlayerSnapshot }
    | { kind: 'player-leave'; id: PlayerId }
    /** No consumer yet — which scripts run on which entities is on the wire nowhere else. */
    | { kind: 'attach'; netId: NetId; scriptClass: string };

/** The `kind` of a structural op, for exhaustiveness checks over the journal. */
export type WireStructuralOpKind = WireStructuralOp['kind'];

/**
 * Which `@serverState` host a diff addresses. Core's `StateMark` names the host by `object`, which
 * cannot cross a wire, so it travels as an address the client resolves through core's host table.
 */
export type StateHostAddr =
    { kind: 'game' } | { kind: 'player'; id: PlayerId } | { kind: 'entity'; netId: NetId };

/**
 * One host's `@serverState` writes for this tick, as a field → value map.
 *
 * Grouped under the host rather than one entry per field, because the address is the larger half of
 * a per-field entry and an entity with several dirty fields would repeat it verbatim each time.
 * Field names therefore travel as KEYS, which is what puts them under the codec's reserved-key
 * check — so a field named `__proto__` is refused rather than applied, and the sender must drop it.
 *
 * Scoping rides the discriminant — a `player` diff appears only in its owner's envelope while a
 * `game` diff goes to everyone.
 */
export type StateDiff = { host: StateHostAddr; fields: { [field: string]: JsonValue } };

/**
 * The seven fields core's transform store holds per entity, in its own order.
 *
 * Whole-value rather than per-field-optional: core's transform channel is a dense per-entity dirty
 * set naming WHICH entities moved, not which fields.
 */
export type WireTransform = {
    posX: number;
    posY: number;
    posZ: number;
    rot: number;
    scale: number;
    opacity: number;
    /** Core backs this with an `Int32Array`, so a fractional value does not round-trip. */
    layer: number;
};

/**
 * One dirty entity's current transform.
 *
 * Flattened rather than nested, because this is the highest-volume type on the wire and a nesting
 * level costs two braces per entity per send-tick under JSON.
 */
export type TransformDiff = WireTransform & { netId: NetId };

/**
 * One entity as a joiner, interest re-entrant, or spawn must receive it: enough to RECONSTRUCT,
 * not just enough to draw.
 */
export type EntitySnapshot = {
    netId: NetId;
    template: string;
    /** Where it sits in the hierarchy. `null` = a child of the world root. */
    parent: NetId | null;
    /**
     * The owning player's id, or `null` for an unowned body. Required rather than optional: a
     * client cannot infer it, and inferring from the template is wrong for any game with more than
     * one player-owned entity.
     */
    owner: PlayerId | null;
    /** Every tag currently on it — what `game.find` queries. */
    tags: string[];
    /** All seven fields, none of them defaultable. */
    transform: WireTransform;
};

/** One player as a joiner must receive it. Shared with `player-join`. */
export type PlayerSnapshot = { id: PlayerId; index: number; name: string };

/**
 * The whole world this player may see, at one tick.
 *
 * For every channel the steady-state path can modify, the snapshot supplies a baseline — the
 * invariant most easily broken one channel at a time, since each omission looks local and the
 * failure appears only on a mid-session join.
 */
export type WorldSnapshot = {
    /** Authoritative — the client's tick counter seeds from this, and `Welcome` carries no tick. */
    tick: number;
    /** PARENTS BEFORE CHILDREN — a wire requirement, not a convention. */
    entities: EntitySnapshot[];
    players: PlayerSnapshot[];
    state: StateDiff[];
};

/**
 * An axis-aligned rectangle, named by its edges. Restated rather than imported from math, where
 * `Bounds` is declared an `interface` and so cannot cross the wire.
 */
export type WireBounds = { left: number; right: number; top: number; bottom: number };

/** One panel-authored named region, as core's manifest declares it. */
export type WireRegion = { name: string; bounds: WireBounds };

/**
 * A panel-loaded asset a joining client must fetch. Core's `AssetRef` resolves to a CLASS with
 * `readonly` fields, so it cannot cross a wire; this is core's manifest-entry shape instead.
 */
export type WireAssetRef = {
    key: string;
    kind: WireAssetKind;
    /** Core loads nothing — the panel does — so a client handed a key with no source cannot fetch it. */
    url: string;
    meta?: { width?: number; height?: number; duration?: number };
};

/** Core's `AssetKind` restated. These are core's kinds, not the renderer's. */
export type WireAssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

/**
 * How to draw the entities of one template.
 *
 * It deliberately carries NO transform: those fields are per-entity and authoritative from the
 * simulation, so carrying them here too would give the client two sources for one value. A
 * {@link TemplateChild} is the one thing beneath it that does carry one, because nothing simulates
 * a child and its offset therefore has no other source.
 */
export type TemplateVisual = SpriteTemplateVisual | GroupTemplateVisual;

/** A template whose entities draw a sprite. `texture` keys into {@link WireAssetRef}. */
export type SpriteTemplateVisual = {
    template: string;
    kind: 'sprite';
    texture: string;
    /** 0..1 pivot inside the art. Absent = centered, the renderer's own default. */
    anchorX?: number;
    anchorY?: number;
    tint?: number;
    /** For visuals that exceed their bounds — glow, thick stroke, emitter. */
    neverCull?: boolean;
};

/** A template whose entities are positional pivots, drawing whatever `children` hangs beneath them. */
export type GroupTemplateVisual = {
    template: string;
    kind: 'group';
    /**
     * The art every entity of this template draws, as a subtree the client builds in one call.
     *
     * ABSENT for a bare pivot, never `undefined`. Recursive, so a receiver has to bound depth and
     * total node count as well as each level's cardinality — one number per level bounds neither.
     */
    children?: TemplateChild[];
};

/**
 * One node inside a group template's subtree: art the TEMPLATE owns, not an entity.
 *
 * This is the one place a visual carries a transform, and the reason the rule differs here is that
 * nothing simulates a child — no `WireTransform` will ever name it, so its offset from the parent
 * node has no second source to disagree with. Every field is local to the parent node, and only
 * the offset reaches descendants: the renderer composes position and visibility and nothing else.
 */
export type TemplateChild = SpriteTemplateChild | GroupTemplateChild;

/** Art under a template's root. `texture` keys into {@link WireAssetRef}, as a sprite visual's does. */
export type SpriteTemplateChild = {
    kind: 'sprite';
    texture: string;
    /** Local to the parent node, in world units. Absent = 0, never `undefined`. */
    offsetX?: number;
    offsetY?: number;
    offsetZ?: number;
    /** Degrees. Does not inherit, so a badge over a spinning parent stays upright at 0. */
    rotation?: number;
    /** Uniform, as {@link WireTransform.scale} is. */
    scale?: number;
    alpha?: number;
    /** 0..1 pivot inside the art. Absent = centered, the renderer's own default. */
    anchorX?: number;
    anchorY?: number;
    tint?: number;
    /** Draw order among siblings. */
    layer?: number;
    /** For visuals that exceed their bounds — glow, thick stroke, emitter. */
    neverCull?: boolean;
};

/**
 * A pivot under a template's root, and the arm that nests.
 *
 * It carries the offset and `layer` and nothing else: a group has no art, so rotation, scale and
 * alpha would be inert on it, and omitting them is what stops an author reading one as "rotates
 * its children".
 */
export type GroupTemplateChild = {
    kind: 'group';
    offsetX?: number;
    offsetY?: number;
    offsetZ?: number;
    layer?: number;
    children?: TemplateChild[];
};

/**
 * What the renderer needs to draw a `netId` at all. The client runs no scripts and holds no panel
 * templates, so it cannot know which art `'coin'` draws.
 */
export type RenderManifest = { assets: WireAssetRef[]; templates: TemplateVisual[] };

/** Client → server, on the refresh interval. The join's sample rides `JoinRequest.clientSentMs`. */
export type TimeSync = { kind: 'time-sync'; clientSentMs: number };

/**
 * Server → client. Echoes the client's stamp, adds its own, and names its tick.
 *
 * Only the client's own two stamps are differenced, so no agreement between the two machines'
 * wall-clocks is needed; treating `serverSentMs` as comparable to a client stamp is the classic
 * error.
 */
export type TimeSyncReply = {
    kind: 'time-sync-reply';
    clientSentMs: number;
    serverSentMs: number;
    serverTick: number;
};

/**
 * Server → client: the timestep changed, and the client resyncs rather than retunes it live.
 *
 * `sendRate` needs no counterpart because nothing can change it at runtime; if that ever becomes
 * possible, WIDEN this to carry both rates rather than adding a second envelope.
 */
export type RateChange = { kind: 'rate-change'; tick: number; simRate: number };

/** Client → server, at most one per tick. Tick-indexed input. */
export type InputFrame = {
    kind: 'input';
    tick: number;
    /** One per tick, so seq and tick advance together — what makes `ackSeq` tick-aligned. */
    seq: number;
    /** Every action for this tick. Empty is not sent. */
    actions: InputAction[];
};

/**
 * One action's edge on one tick.
 *
 * Every edge is sent, because edges are not idempotent and a dropped `release` leaves a key held
 * forever; held and axis state is sampled once per tick instead, which is.
 */
export type InputAction = {
    action: string;
    on: InputPhase;
    /** Axis magnitude or hold sample. ABSENT for a plain press/release edge, never `undefined`. */
    value?: number;
};

/**
 * Which edge of a sustained input this is. Restates core's `EventPhase` rather than importing it,
 * which would put the simulation in a client's module graph just to parse a frame.
 */
export type InputPhase = 'press' | 'release' | 'hold';

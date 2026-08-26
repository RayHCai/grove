// Every envelope must stay assignable to transport's `JsonValue`: declared `type` and never
// `interface` (an interface gets no implicit index signature), no `readonly` field or array, and an
// optional field means the key is ABSENT rather than explicitly `undefined`.

import type { JsonValue } from '@platform/transport';
import type { NetId, PlayerId, ProjectId } from './ids.js';

/** Everything the server may send — the authoritative list for this direction. */
export type ServerToClient =
    | Welcome
    | SnapshotChunk
    | Reject
    | StateEnvelope
    | TransformEnvelope
    | ManifestUpdate
    | TimeSyncReply
    | RateChange;

/** Everything a client may send — the authoritative list for this direction. */
export type ClientToServer = JoinRequest | InputFrame | InteractionFrame | TimeSync;

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

    /** Which project this client believes it is playing. */
    projectId: ProjectId;
    /**
     * Which build of it. The two ends predict by replaying one input through the same script code,
     * so different bytes diverge silently and the correction path reports it as jitter — which is
     * why this is refused at the handshake rather than reconciled later.
     */
    projectHash: string;
    /** The script bundle this client already holds, or `''` for none — a joiner has fetched none. */
    bundleHash: string;

    /** Reconnect rebind; a reconnect path must OMIT the key rather than pass `undefined`. */
    token?: string;
};

/** Server → one client, once, in reply. It carries what a joiner cannot guess and nothing else. */
export type Welcome = {
    kind: 'welcome';
    protocolVersion: number;
    yourPlayerId: PlayerId;
    yourPlayerIndex: number;

    /** What the authority is running. A joiner disagreeing with these never reaches this envelope. */
    projectId: ProjectId;
    projectHash: string;
    /**
     * Lowercase-hex SHA-256 of the bytes at {@link Welcome.bundleUrl}, or `''` when there is no
     * bundle. The client verifies against this BEFORE evaluating, which is the whole mechanism.
     */
    bundleHash: string;
    /**
     * Where to fetch the script bundle — over HTTP, never this socket, which carries no bytes a
     * client executes. `''` when the client's own build already holds the code.
     *
     * The second wire field that makes a client act on the network rather than just parse, and the
     * more dangerous one: an asset is data and this is executable, so the receiver constrains the
     * scheme exactly as it does {@link WireAssetRef.url}.
     */
    bundleUrl: string;

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
    /**
     * How many `SnapshotChunk` frames preceded this one, whose contents belong to `snapshot`.
     *
     * ABSENT when the whole world fitted in this frame, which is the ordinary case. The count rides
     * here rather than on the chunks so the `Welcome` remains the single frame that completes a join:
     * a receiver holding a partial set has not been told a join happened at all.
     */
    snapshotChunks?: number;
    /** What the renderer needs to draw a netId at all. */
    visuals: RenderManifest;

    /** Opaque; presented on a later connect() to rebind. Unused in MVP — omitted, not `undefined`. */
    reconnectToken?: string;
};

/**
 * Server → client, ahead of a `Welcome` whose world does not fit in one frame.
 *
 * Transport refuses a frame over `MAX_FRAME_BYTES` before parsing it, and a refused `Welcome` is
 * unrecoverable on its own: the client's answer to a broken session is a resync, which asks for the
 * same snapshot again. So a producer that approaches the cap divides its payload here rather than
 * asking for a bigger frame — the cap bounds what one parse allocates, and raising it would give that
 * bound away for every peer.
 *
 * Only `entities` and `state` are split; the roster and the two rates are bounded by `maxPlayers` and
 * by being scalars, so they stay on the `Welcome`. Chunks precede it and carry no tick of their own:
 * they describe the tick their `Welcome`'s snapshot names, and a set with no `Welcome` behind it is
 * never applied.
 */
export type SnapshotChunk = {
    kind: 'snapshot-chunk';
    /** Position in the sequence, from zero. The receiver applies them in this order and no other. */
    index: number;
    /** Entities in the same parents-before-children order the whole snapshot would have carried. */
    entities: EntitySnapshot[];
    state: StateDiff[];
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

/**
 * Coarse on purpose: finer detail belongs in a log, not on a wire an unauthenticated peer reaches.
 *
 * `identity` covers every disagreement about WHAT is being run — project, build or held bundle —
 * and says nothing about which, for the same reason.
 */
export type RejectReason = 'version' | 'full' | 'identity';

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
 * The data wrappers whose state replicates, named by the tag their payload carries.
 *
 * Restated rather than imported from core, for the reason `InputPhase` is: importing would put the
 * simulation in a client's module graph. Parity-locked to core's `WrapperKind` through the dev-only
 * reference, so adding a fifth wrapper there breaks this.
 */
export type WireWrapperKind = 'Scoreboard' | 'Leaderboard' | 'Inventory' | 'Team';

/**
 * A wrapper's state as one `StateDiff` field value.
 *
 * A wrapper is a class, which no codec can carry, so it travels as this tagged form — and the TAG is
 * what a receiver holding no scripts rebuilds the class from, which is why every constructor
 * argument appears here: `Leaderboard`'s order decides what `top` means, `Team`'s name is its
 * identity, and `Inventory`'s player is the one it belongs to.
 *
 * Maps travel as entry PAIRS rather than as objects, so a creator-chosen item name or player id can
 * never land in key position — the codec's reserved-key check is about keys, and an inventory item
 * called `__proto__` would otherwise be a refused frame rather than an ordinary one.
 */
export type WireWrapperState =
    | { kind: 'Scoreboard'; scores: Array<[string, number]> }
    | { kind: 'Leaderboard'; order: 'high' | 'low'; scores: Array<[string, number]> }
    | { kind: 'Inventory'; player: PlayerId; items: Array<[string, number]> }
    | { kind: 'Team'; name: string; members: string[] };

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

/**
 * Server → client: templates that came into use after this client joined, and the assets they need.
 *
 * `Welcome.visuals` is a baseline, not the whole manifest for a session — a template first used at
 * tick 5000 is in no earlier joiner's copy, so without this arm every entity of it draws as the
 * placeholder for the rest of the session while a client joining a second later sees it correctly.
 *
 * ADDITIONS, never a replacement: the client merges rather than swapping, so an entry it is already
 * drawing with is not re-fetched. It carries no tick, because a visual is not tick-ordered state —
 * but the server sends it AHEAD of the `state` envelope that first spawns an entity using it, or the
 * node is created against a table that does not know the template yet.
 */
export type ManifestUpdate = { kind: 'manifest'; visuals: RenderManifest };

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

/**
 * Client → server, at most one per tick. HUD presses and pointer hits the client already resolved.
 *
 * Apart from `InputFrame` because these are not actions: they carry no phase, they are not folded
 * into held/axis state, and they are not replayed — so putting them in `actions[]` would make every
 * one of those rules conditional on a name. Unacked and unbuffered for the same reason: a press is
 * one discrete event, and a lost one is lost rather than re-derivable from a later sample.
 */
export type InteractionFrame = {
    kind: 'interaction';
    /** The client tick it happened on, the same index an `InputFrame` carries. */
    tick: number;
    events: Interaction[];
};

/**
 * One interaction, already resolved against the client's own HUD layout and camera.
 *
 * Neither half is recomputable by the authority — a widget's hit box is panel layout the server does
 * not hold, and a cursor position means nothing without that client's camera — so both arrive as the
 * peer's claim, named by widget and by `netId` respectively. The server checks the entity is alive
 * and nothing more; a handler that grants something must check reach itself.
 */
export type Interaction =
    | { kind: 'press'; widget: string; screen?: string }
    | { kind: 'click'; netId: NetId }
    | { kind: 'hover-enter'; netId: NetId }
    | { kind: 'hover-exit'; netId: NetId };

/** The `kind` of an interaction, for exhaustiveness checks over the arm. */
export type InteractionKind = Interaction['kind'];

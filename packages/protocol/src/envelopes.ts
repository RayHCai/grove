// Every envelope must stay assignable to transport's `JsonValue`: declared `type` and never
// `interface` (an interface gets no implicit index signature), no `readonly` field or array, and an
// optional field means the key is ABSENT rather than explicitly `undefined`.

import type { AssetId, ScriptId, ScriptProps, TemplateId } from '@platform/project';
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
export type ClientToServer = JoinRequest | InputFrame | InteractionFrame | RequestFrame | TimeSync;

/** Either direction, for code that handles a frame before it knows which way it came. */
export type Envelope = ServerToClient | ClientToServer;

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
    /** Which build of it: different bytes diverge silently, and the drift reads as jitter. */
    projectHash: string;
    /** The bundle this client already holds, or `''`; a joiner has fetched none. */
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

    /** What the authority is running. A joiner disagreeing never reaches this envelope. */
    projectId: ProjectId;
    projectHash: string;
    /** Lowercase-hex SHA-256 of the bytes at {@link Welcome.bundleUrl}, or `''` for none. */
    bundleHash: string;
    /** Fetched over HTTP, never this socket, which carries no bytes a client executes. */
    bundleUrl: string;

    /** Fixed timestep and broadcast cadence. Panel-authored, so the client cannot assume 60/20. */
    simRate: number;
    sendRate: number;

    /** Build-time constants a joiner can no more guess than the two rates. */
    bounds: WireBounds;
    regions: WireRegion[];

    /** Echoed from the JoinRequest, plus the server's own stamp — one RTT sample. */
    clientSentMs: number;
    serverSentMs: number;

    /** The tick rides on the snapshot, so what a joiner seeds from and what it describes agree. */
    snapshot: WorldSnapshot;
    /** How many `SnapshotChunk` frames preceded this one. ABSENT when the world fitted in one. */
    snapshotChunks?: number;
    /** What the renderer needs to draw a netId at all. */
    visuals: RenderManifest;

    /** Opaque; presented on a later connect() to rebind. Omitted, never `undefined`. */
    reconnectToken?: string;
};

/** Server → client, ahead of a `Welcome` whose world does not fit in one frame. */
export type SnapshotChunk = {
    kind: 'snapshot-chunk';
    /** Position in the sequence, from zero; the receiver applies them in this order only. */
    index: number;
    /** Entities in the same parents-before-children order the whole snapshot would have carried. */
    entities: EntitySnapshot[];
    state: StateDiff[];
};

/** Server → client instead of a `Welcome`, just before `close()`; a bare close cannot say why. */
export type Reject = {
    kind: 'reject';
    reason: RejectReason;
    /** What the server speaks, so the client can say "update the game" rather than "try again". */
    serverProtocolVersion: number;
};

/** Coarse on purpose: detail belongs in a log, not on a wire an unauthenticated peer reaches. */
export type RejectReason = 'version' | 'full' | 'identity';

/** Server → client, every send-tick. RELIABLE — every op must arrive, in order. */
export type StateEnvelope = {
    kind: 'state';
    tick: number;
    /** Highest contiguous RESOLVED seq for THIS connection. */
    ackSeq: number;
    /** Spare ticks the EARLIEST input this ack resolved had on arrival; a mean drops the tail. */
    earliestHeadroom?: number;
    /** Ordered journal, applied verbatim — the ops do not commute, and a drop is unrecoverable. */
    structural: WireStructuralOp[];
    /** One entry per host with writes this tick, scoped to this connection's player. */
    state: StateDiff[];
};

/** Server → client, every send-tick. DROPPABLE — superseded by the next by construction. */
export type TransformEnvelope = {
    kind: 'transform';
    /** The tick of the `StateEnvelope` it accompanies — an equality, and the join key. */
    tick: number;
    transform: TransformDiff[];
};

/** One indivisible entry in the ordered structural journal. */
export type WireSingleStructuralOp =
    | { kind: 'spawn'; snapshot: EntitySnapshot }
    | { kind: 'destroy'; netId: NetId }
    | { kind: 'reparent'; netId: NetId; parent: NetId | null }
    | { kind: 'tag'; netId: NetId; tag: string; added: boolean }
    /** Distinct from spawn/destroy: an entity leaving a view is still alive server-side. */
    | { kind: 'enter-interest'; snapshot: EntitySnapshot }
    | { kind: 'leave-interest'; netId: NetId }
    /** Carries the roster because nothing else on the wire names a player. */
    | { kind: 'player-join'; player: PlayerSnapshot }
    | { kind: 'player-leave'; id: PlayerId }
    /** Which script runs on which entity — on the wire nowhere else. */
    | ({ kind: 'attach'; netId: NetId } & WireScriptAttachment);

/** Every op one template instantiation produced, applied as one. A BOUNDARY, not a reordering. */
export type WireStructuralGroup = { kind: 'group'; ops: WireSingleStructuralOp[] };

/** One entry in the ordered structural journal. */
export type WireStructuralOp = WireSingleStructuralOp | WireStructuralGroup;

/** The `kind` of a structural op, for exhaustiveness checks over the journal. */
export type WireStructuralOpKind = WireStructuralOp['kind'];

/** One script on one entity, as both the `attach` op and a spawn's overrides carry it. */
export type WireScriptAttachment = { script: ScriptId; props?: ScriptProps };

/**
 * Which `@serverState` host a diff addresses. Core's `StateMark` names the host by `object`, which
 * cannot cross a wire, so it travels as an address the client resolves through core's host table.
 */
export type StateHostAddr =
    { kind: 'game' } | { kind: 'player'; id: PlayerId } | { kind: 'entity'; netId: NetId };

/** One host's `@serverState` writes this tick, field → value; scoping rides the discriminant. */
export type StateDiff = { host: StateHostAddr; fields: { [field: string]: JsonValue } };

/** The data wrappers whose state replicates, by payload tag. Parity-locked to `WrapperKind`. */
export type WireWrapperKind = 'Scoreboard' | 'Leaderboard' | 'Inventory' | 'Team';

/**
 * A wrapper's state as one `StateDiff` value: the tag plus every constructor argument.
 * Maps travel as entry PAIRS, so a creator-chosen name never lands in key position.
 */
export type WireWrapperState =
    | { kind: 'Scoreboard'; scores: Array<[string, number]> }
    | { kind: 'Leaderboard'; order: 'high' | 'low'; scores: Array<[string, number]> }
    | { kind: 'Inventory'; player: PlayerId; items: Array<[string, number]> }
    | { kind: 'Team'; name: string; members: string[] };

/** The seven fields core's transform store holds per entity, in its own order. Whole-value. */
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
 * One dirty entity's current transform. Flattened rather than nested, because this is the
 * highest-volume type on the wire and a nesting level costs two braces per entity per send-tick.
 */
export type TransformDiff = WireTransform & { netId: NetId };

/** One entity as a joiner, interest re-entrant, or spawn must receive it: enough to RECONSTRUCT. */
export type EntitySnapshot = {
    netId: NetId;
    /** Keys the render manifest on one end and a template registry on the other. */
    template: TemplateId;
    /** Where it sits in the hierarchy. `null` = a child of the world root. */
    parent: NetId | null;
    /**
     * The owning player's id, or `null` for an unowned body. Required rather than optional: a
     * client cannot infer it, and the template is wrong for any game with two player-owned kinds.
     */
    owner: PlayerId | null;
    /** Every tag currently on it — what `game.find` queries. */
    tags: string[];
    /** All seven fields, none of them defaultable. */
    transform: WireTransform;
    /** ABSENT for an entity the template describes whole, which is the ordinary case. */
    overrides?: EntityOverrides;
};

/** Per-instance deviations from a template — the baseline a delta `attach` has none for. */
export type EntityOverrides = {
    /** Every script, in attachment order — the whole list, not a merge over the template's. */
    scripts?: WireScriptAttachment[];
};

/** One player as a joiner must receive it. Shared with `player-join`. */
export type PlayerSnapshot = { id: PlayerId; index: number; name: string };

/** The whole world this player may see, at one tick; every channel supplies a baseline. */
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
    key: AssetId;
    kind: WireAssetKind;
    /** Core loads nothing — the panel does — so a key with no source cannot be fetched. */
    url: string;
    meta?: { width?: number; height?: number; duration?: number };
};

/** Core's `AssetKind` restated. These are core's kinds, not the renderer's. */
export type WireAssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

/** How to draw the entities of one template. Carries NO transform: those are per-entity. */
export type TemplateVisual = SpriteTemplateVisual | GroupTemplateVisual;

/** A template whose entities draw a sprite. `texture` keys into {@link WireAssetRef}. */
export type SpriteTemplateVisual = {
    template: TemplateId;
    kind: 'sprite';
    texture: AssetId;
    /** 0..1 pivot inside the art. Absent = centered, the renderer's own default. */
    anchorX?: number;
    anchorY?: number;
    tint?: number;
    /** For visuals that exceed their bounds — glow, thick stroke, emitter. */
    neverCull?: boolean;
};

/** A template whose entities are positional pivots, drawing whatever `children` hangs below. */
export type GroupTemplateVisual = {
    template: TemplateId;
    kind: 'group';
    /** The art every entity of this template draws, as a subtree the client builds in one call. */
    children?: TemplateChild[];
};

/**
 * One node inside a group template's subtree: art the TEMPLATE owns, not an entity.
 * The one place a visual carries a transform; only the offset reaches descendants.
 */
export type TemplateChild = SpriteTemplateChild | GroupTemplateChild;

/** Art under a template's root. `texture` keys into {@link WireAssetRef}, as a sprite does. */
export type SpriteTemplateChild = {
    kind: 'sprite';
    texture: AssetId;
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

/** A pivot under a template's root, carrying offset and `layer` only: a group has no art. */
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

/** Server → client: render-manifest ADDITIONS, which the client merges rather than swapping. */
export type ManifestUpdate = { kind: 'manifest'; visuals: RenderManifest };

/** Client → server, on the refresh interval. The join's sample rides `JoinRequest.clientSentMs`. */
export type TimeSync = { kind: 'time-sync'; clientSentMs: number };

/** Server → client, echoing the client's stamp; only the client's own two are differenced. */
export type TimeSyncReply = {
    kind: 'time-sync-reply';
    clientSentMs: number;
    serverSentMs: number;
};

/** Server → client: the timestep changed, and the client resyncs rather than retuning live. */
export type RateChange = { kind: 'rate-change'; simRate: number };

/** Client → server, at most one per tick. Tick-indexed input. */
export type InputFrame = {
    kind: 'input';
    tick: number;
    /** One per tick, so seq and tick advance together — what makes `ackSeq` tick-aligned. */
    seq: number;
    /** Every action for this tick. Empty is not sent. */
    actions: InputAction[];
};

/** One action's edge on one tick. Every edge is sent: a dropped `release` holds a key forever. */
export type InputAction = {
    action: string;
    on: InputPhase;
    /** Axis magnitude or hold sample. ABSENT for a plain press/release edge, never `undefined`. */
    value?: number;
};

/** Which edge of a sustained input this is. Restates core's `EventPhase`, never imports it. */
export type InputPhase = 'press' | 'release' | 'hold';

/** Client → server, at most one per tick. HUD presses and pointer hits, already resolved. */
export type InteractionFrame = {
    kind: 'interaction';
    /** The client tick it happened on, the same index an `InputFrame` carries. */
    tick: number;
    events: Interaction[];
};

/** One interaction, already resolved against the client's own HUD layout and camera. */
export type Interaction =
    | { kind: 'press'; widget: string; screen?: string }
    | { kind: 'click'; netId: NetId }
    | { kind: 'hover-enter'; netId: NetId }
    | { kind: 'hover-exit'; netId: NetId };

/** Client → server, at most one per tick. The asks a client cannot perform itself. */
export type RequestFrame = {
    kind: 'request';
    /** The client tick it was made on, the same index an `InputFrame` carries. */
    tick: number;
    requests: GameRequest[];
};

/**
 * One `request()` call: the handler name, and the payload that handler must validate.
 * `data` carries its fields as KEYS, so a sender drops a reserved name rather than emit it.
 */
export type GameRequest = { name: string; data?: { [field: string]: JsonValue } };

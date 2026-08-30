// A types-only package's meaningful tests are compile-time ones: `tsc -p tsconfig.test.json` is the
// real assertion, and the `expect` calls exist so a reader sees which invariant broke rather than
// one long list of TS errors.

import { describe, expect, it } from 'vitest';
import type { Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
// Type-only, and reachable from tests alone: `@platform/core` is a devDependency and a reference of
// `tsconfig.test.json` only, so the parity checks below pin the restated types without core
// appearing in any shipped module graph.
import type { AssetKind, EntityId, EventPhase, TransformBuffer, WrapperKind } from '@platform/core';
import type { AssetId, ScriptId, TemplateId } from '@platform/project';
import type {
    ClientToServer,
    EntityOverrides,
    EntitySnapshot,
    Envelope,
    InputFrame,
    InputPhase,
    Interaction,
    InteractionFrame,
    JoinRequest,
    ManifestUpdate,
    NetId,
    RateChange,
    Reject,
    RejectReason,
    ServerToClient,
    SnapshotChunk,
    StateEnvelope,
    TemplateChild,
    TemplateVisual,
    TimeSync,
    TimeSyncReply,
    TransformDiff,
    TransformEnvelope,
    Welcome,
    WireAssetKind,
    WireAssetRef,
    WireScriptAttachment,
    WireSingleStructuralOp,
    WireStructuralGroup,
    WireStructuralOp,
    WireStructuralOpKind,
    WireTransform,
    WireWrapperKind,
    WireWrapperState,
    WorldSnapshot,
} from '../src/index.js';
import { PROTOCOL_VERSION } from '../src/index.js';

/** Fails to compile unless `T` is assignable to `U`. */
type Assignable<T extends U, U> = T;
/**
 * `true` only when the two types are mutually assignable; the tuples stop a union distributing.
 *
 * Spelled as a check plus `Assert` rather than one `Exact<T, U, V = T>` helper, because that form
 * needs its third parameter to escape a circular constraint — and anything passed for it, as in
 * `Exact<A, B, string>`, silently disables the reverse direction while still compiling.
 */
type IsMutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;
/** Fails to compile unless `T` is `never` — how an exhaustive union check reports a leftover arm. */
type Empty<T extends never> = T;

const netId = (n: number): NetId => n as NetId;
const templateId = (key: string): TemplateId => key as TemplateId;
const scriptId = (key: string): ScriptId => key as ScriptId;
const assetId = (key: string): AssetId => key as AssetId;

const transform: WireTransform = {
    posX: 1,
    posY: 2,
    posZ: 3,
    rot: 90,
    scale: 2,
    opacity: 0.5,
    layer: 4,
};

const entity: EntitySnapshot = {
    netId: netId(16_777_216),
    template: templateId('wall'),
    parent: null,
    owner: null,
    tags: ['solid'],
    transform,
};

/** One turret and its barrel: the shape a template subtree produces on the wire. */
const turretGroup: WireStructuralGroup = {
    kind: 'group',
    ops: [
        {
            kind: 'spawn',
            snapshot: { ...entity, netId: netId(20), template: templateId('turret') },
        },
        { kind: 'attach', netId: netId(20), script: scriptId('aim'), props: { range: 120 } },
        {
            kind: 'spawn',
            snapshot: { ...entity, netId: netId(21), template: templateId('barrel') },
        },
        { kind: 'reparent', netId: netId(21), parent: netId(20) },
    ],
};

const snapshot: WorldSnapshot = {
    tick: 4821,
    entities: [entity],
    players: [{ id: 'p1', index: 0, name: 'Ray' }],
    state: [{ host: { kind: 'game' }, fields: { round: 3 } }],
};

const welcome: Welcome = {
    kind: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    yourPlayerId: 'p1',
    yourPlayerIndex: 0,
    projectId: 'arcade',
    projectHash: 'a1b2c3',
    bundleHash: 'd4e5f6',
    bundleUrl: '/bundle.js',
    simRate: 60,
    sendRate: 20,
    bounds: { left: -100, right: 100, top: 100, bottom: -100 },
    regions: [{ name: 'arena', bounds: { left: -10, right: 10, top: 10, bottom: -10 } }],
    clientSentMs: 1000,
    serverSentMs: 1050,
    snapshot,
    visuals: {
        assets: [
            {
                key: assetId('coin'),
                kind: 'texture',
                url: 'coin.png',
                meta: { width: 16, height: 16 },
            },
        ],
        templates: [
            {
                template: templateId('coin'),
                kind: 'sprite',
                texture: assetId('coin'),
                anchorX: 0.5,
                anchorY: 0.5,
            },
            { template: templateId('spawner'), kind: 'group' },
            // Nested, so the recursive arm rides the same encode and round-trip as everything else.
            {
                template: templateId('turret'),
                kind: 'group',
                children: [
                    { kind: 'sprite', texture: assetId('coin'), offsetY: -4 },
                    {
                        kind: 'group',
                        offsetY: 12,
                        children: [
                            { kind: 'sprite', texture: assetId('coin'), rotation: 90, layer: 1 },
                        ],
                    },
                ],
            },
        ],
    },
};

const reject: Reject = {
    kind: 'reject',
    reason: 'version',
    serverProtocolVersion: PROTOCOL_VERSION,
};

const stateEnvelope: StateEnvelope = {
    kind: 'state',
    tick: 4821,
    ackSeq: 337,
    structural: [{ kind: 'spawn', snapshot: entity }, turretGroup],
    state: [{ host: { kind: 'player', id: 'p1' }, fields: { coins: 7, lives: 3 } }],
};

const transformEnvelope: TransformEnvelope = {
    kind: 'transform',
    tick: 4821,
    transform: [{ ...transform, netId: netId(1) }],
};

const timeSyncReply: TimeSyncReply = {
    kind: 'time-sync-reply',
    clientSentMs: 1,
    serverSentMs: 2,
    serverTick: 3,
};

const rateChange: RateChange = { kind: 'rate-change', tick: 4821, simRate: 30 };

const joinRequest: JoinRequest = {
    kind: 'join-request',
    protocolVersion: PROTOCOL_VERSION,
    name: 'Ray',
    clientSentMs: 1,
    projectId: 'arcade',
    projectHash: 'a1b2c3',
    // A joiner holds no bundle yet, which is what the empty string means and why it is not optional.
    bundleHash: '',
};

const inputFrame: InputFrame = {
    kind: 'input',
    tick: 4821,
    seq: 337,
    actions: [{ action: 'jump', on: 'press' }],
};

const timeSync: TimeSync = { kind: 'time-sync', clientSentMs: 9 };

const interactionFrame: InteractionFrame = {
    kind: 'interaction',
    tick: 4821,
    events: [
        { kind: 'press', widget: 'buy', screen: 'shop' },
        { kind: 'click', netId: netId(16_777_216) },
    ],
};

// The rule that makes the whole vocabulary usable, and the one whose failures read like nothing to
// do with design: they surface at the `send` call as assignability errors.

type _JoinRequestIsMessage = Assignable<JoinRequest, Message>;
type _WelcomeIsMessage = Assignable<Welcome, Message>;
type _SnapshotChunkIsMessage = Assignable<SnapshotChunk, Message>;
type _RejectIsMessage = Assignable<Reject, Message>;
type _StateIsMessage = Assignable<StateEnvelope, Message>;
type _TransformIsMessage = Assignable<TransformEnvelope, Message>;
type _TimeSyncIsMessage = Assignable<TimeSync, Message>;
type _TimeSyncReplyIsMessage = Assignable<TimeSyncReply, Message>;
type _ManifestUpdateIsMessage = Assignable<ManifestUpdate, Message>;
type _RateChangeIsMessage = Assignable<RateChange, Message>;
type _InputFrameIsMessage = Assignable<InputFrame, Message>;
type _InteractionFrameIsMessage = Assignable<InteractionFrame, Message>;
type _ServerToClientIsMessage = Assignable<ServerToClient, Message>;
type _ClientToServerIsMessage = Assignable<ClientToServer, Message>;

// The payload types too: a `readonly` or an `interface` slipped into one of these otherwise fails at
// the envelope, which is harder to read.
type _StructuralOpIsMessage = Assignable<WireStructuralOp, Message>;
type _TransformDiffIsMessage = Assignable<TransformDiff, Message>;
type _SnapshotIsMessage = Assignable<WorldSnapshot, Message>;
// The one recursive shape on the wire, so it is the one that can lose assignability at a depth
// nothing else reaches.
type _TemplateChildIsMessage = Assignable<TemplateChild, Message>;
type _TemplateVisualIsMessage = Assignable<TemplateVisual, Message>;

const snapshotChunk: SnapshotChunk = {
    kind: 'snapshot-chunk',
    index: 0,
    entities: [entity],
    state: [{ host: { kind: 'game' }, fields: { round: 3 } }],
};

const manifestUpdate: ManifestUpdate = {
    kind: 'manifest',
    visuals: {
        assets: [{ key: assetId('gem'), kind: 'texture', url: 'gem.png' }],
        templates: [{ template: templateId('gem'), kind: 'sprite', texture: assetId('gem') }],
    },
};

const serverFrames: ServerToClient[] = [
    welcome,
    snapshotChunk,
    reject,
    stateEnvelope,
    transformEnvelope,
    manifestUpdate,
    timeSyncReply,
    rateChange,
];
const clientFrames: ClientToServer[] = [joinRequest, inputFrame, interactionFrame, timeSync];

describe('every envelope is assignable to transport Message', () => {
    it('encodes through jsonCodec, which is the runtime half of the same rule', () => {
        // `jsonCodec.encode` throws on anything JSON would silently drop or transform, so a shape
        // that satisfies the compiler and not the wire is caught here.
        const frames: Envelope[] = [...serverFrames, ...clientFrames];
        for (const frame of frames) {
            expect(() => jsonCodec.encode(frame)).not.toThrow();
        }
        expect(frames).toHaveLength(12);
    });

    it('round-trips an envelope to a structurally equal value', () => {
        expect(jsonCodec.decode(jsonCodec.encode(welcome))).toStrictEqual(welcome);
    });
});

// What the discriminant buys: narrowing is a compiler-checked exhaustive switch, and an unknown
// message is a clean rejection rather than a misparse. The `never` in each default is the assertion
// — add another message and the arm stops compiling.

function narrowServerToClient(frame: ServerToClient): string {
    switch (frame.kind) {
        case 'welcome':
            return `welcome@${frame.snapshot.tick}`;
        case 'snapshot-chunk':
            return `chunk#${frame.index}x${frame.entities.length}`;
        case 'reject':
            return `reject:${frame.reason}`;
        case 'state':
            return `state@${frame.tick}/${frame.ackSeq}`;
        case 'transform':
            return `transform@${frame.tick}`;
        case 'manifest':
            return `manifest+${frame.visuals.templates.length}`;
        case 'time-sync-reply':
            return `sync@${frame.serverTick}`;
        case 'rate-change':
            return `rate@${frame.simRate}`;
        default: {
            const unreachable: never = frame;
            return unreachable;
        }
    }
}

function narrowClientToServer(frame: ClientToServer): string {
    switch (frame.kind) {
        case 'join-request':
            return `join:${frame.name}`;
        case 'input':
            return `input@${frame.tick}/${frame.seq}`;
        case 'interaction':
            return `interaction@${frame.tick}x${frame.events.length}`;
        case 'time-sync':
            return `sync@${frame.clientSentMs}`;
        default: {
            const unreachable: never = frame;
            return unreachable;
        }
    }
}

describe('the discriminant narrows both unions exhaustively', () => {
    it('narrows every server-to-client arm', () => {
        expect(serverFrames.map(narrowServerToClient)).toStrictEqual([
            'welcome@4821',
            'chunk#0x1',
            'reject:version',
            'state@4821/337',
            'transform@4821',
            'manifest+1',
            'sync@3',
            'rate@30',
        ]);
    });

    it('narrows every client-to-server arm', () => {
        expect(clientFrames.map(narrowClientToServer)).toStrictEqual([
            'join:Ray',
            'input@4821/337',
            'interaction@4821x2',
            'sync@9',
        ]);
    });

    it('the two unions are disjoint, so a frame cannot be read in the wrong direction', () => {
        // Not decoration: the server's receive path narrows to ClientToServer and the client's to
        // ServerToClient, so an overlapping `kind` would let one end accept a frame it minted.
        type _Disjoint = Empty<ServerToClient['kind'] & ClientToServer['kind']>;

        const serverKinds = serverFrames.map((f) => f.kind);
        const clientKinds: string[] = clientFrames.map((f) => f.kind);
        expect(serverKinds.filter((k) => clientKinds.includes(k))).toStrictEqual([]);
        expect(new Set([...serverKinds, ...clientKinds]).size).toBe(12);
    });
});

describe('the interaction arm carries what the authority cannot recompute', () => {
    it('names a widget by name and a pointer hit by netId, never by coordinate', () => {
        // A widget's hit box is panel layout the server does not hold and a cursor position is
        // meaningless without that client's camera, so both arrive already resolved.
        const encoded = String(jsonCodec.encode(interactionFrame));
        expect(encoded).not.toContain('"x"');
        expect(encoded).toContain('"widget":"buy"');
        expect(encoded).toContain('"netId":16777216');
    });

    it('omits `screen` for a widget outside every screen, rather than sending undefined', () => {
        const loose: Interaction = { kind: 'press', widget: 'pause' };
        expect('screen' in loose).toBe(false);
        expect(jsonCodec.encode(loose)).toBe('{"kind":"press","widget":"pause"}');
    });

    it('is its own frame, so nothing folds an interaction into action state', () => {
        // The arm carries no `on` phase and no `seq`: an interaction is one discrete event, not an
        // edge of a sustained input, and it is neither acked nor replayed.
        const exactFields: Assert<IsMutual<keyof InteractionFrame, 'kind' | 'tick' | 'events'>> =
            true;
        expect(exactFields).toBe(true);
        expect('seq' in interactionFrame).toBe(false);
    });
});

// The coverage Record below is keyed by STRUCTURAL OP, so it sees neither a new reject reason nor a
// new field on an existing arm. Both arrived with session identity, so both get an assertion here.

/** What a client may do about a refusal — the decision a new reason forces someone to make. */
type RejectResponse = 'never-retry' | 'retry-later';

const REJECT_COVERAGE: Record<RejectReason, RejectResponse> = {
    version: 'never-retry',
    // The peer is running other code, so the same client reconnecting reaches the same refusal.
    identity: 'never-retry',
    full: 'retry-later',
};

/** The three fields that must ride BOTH handshake frames, or the comparison has one side only. */
type HandshakeIdentity = 'projectId' | 'projectHash' | 'bundleHash';
type _JoinCarriesIdentity = Assert<
    IsMutual<Extract<keyof JoinRequest, HandshakeIdentity>, HandshakeIdentity>
>;
type _WelcomeCarriesIdentity = Assert<
    IsMutual<Extract<keyof Welcome, HandshakeIdentity>, HandshakeIdentity>
>;

describe('the handshake proves both ends run the same bytes', () => {
    it('every reject reason names whether retrying could ever help', () => {
        // Add a fourth reason and this Record fails to compile, which is the assertion; the values
        // are the human decision it forces, and a client phrases its message from them.
        expect(Object.keys(REJECT_COVERAGE).toSorted()).toStrictEqual([
            'full',
            'identity',
            'version',
        ]);
        expect(REJECT_COVERAGE.identity).toBe('never-retry');
    });

    it('the identity fields are required, so a hash-less frame is not a JoinRequest', () => {
        // @ts-expect-error — omitting one is the shape an older client sends, and it must not pass.
        const hashless: JoinRequest = { ...joinRequest, projectHash: undefined };
        expect(hashless.kind).toBe('join-request');
        expect(Object.keys(joinRequest)).toContain('bundleHash');
    });

    it('only the server names where the bundle is fetched from', () => {
        // The client fetches an address the server chose; the reverse would be a client telling a
        // server to load code, which nothing here has any reason to allow.
        expect('bundleUrl' in joinRequest).toBe(false);
        expect(welcome.bundleUrl).toBe('/bundle.js');
    });
});

// The duplication accepted as the cost of not depending on core. Nothing else catches core adding a
// fourth phase or a seventh asset kind.

type _InputPhaseMatchesCore = Assert<IsMutual<InputPhase, EventPhase>>;
type _AssetKindMatchesCore = Assert<IsMutual<WireAssetKind, AssetKind>>;

describe('restated core types stay in step', () => {
    it('InputPhase is exactly core EventPhase', () => {
        // The Assert above is the assertion; this pins the inhabitants so a failure names them.
        const phases: InputPhase[] = ['press', 'release', 'hold'];
        expect(phases).toStrictEqual(['press', 'release', 'hold']);
    });

    it('WireAssetKind is exactly core AssetKind', () => {
        const kinds: WireAssetKind[] = ['texture', 'atlas', 'audio', 'font', 'clip', 'effect'];
        expect(kinds).toHaveLength(6);
    });
});

// So a field added to core's transform store cannot reach one of `EntitySnapshot` / `TransformDiff`
// and not the other. Both are built from `WireTransform`, so parity between them is structural; the
// third assertion is the one that matters, pinning `WireTransform` against core's own store.

type TransformFields = keyof WireTransform;
type _SnapshotCarriesEveryTransformField = Assert<
    IsMutual<keyof EntitySnapshot['transform'], TransformFields>
>;
type _DiffCarriesEveryTransformField = Assert<
    IsMutual<Exclude<keyof TransformDiff, 'netId'>, TransformFields>
>;

// Core's `TransformBuffer` is the store's per-field array set plus the bookkeeping a capture needs.
// `count` and `slots` describe WHICH slots the buffer covers, which is local to one runtime and
// meaningless to a peer holding its own; dropping them leaves exactly the per-entity fields the wire
// must carry, so a real field added to the store breaks this line and nothing else has to remember to.
type CoreTransformFields = Exclude<keyof TransformBuffer, 'count' | 'slots'>;
type _WireTransformMatchesCore = Assert<IsMutual<TransformFields, CoreTransformFields>>;

describe('EntitySnapshot and TransformDiff carry the same seven fields', () => {
    it('the seven fields are core’s, in core’s order', () => {
        // Order is not type-checkable, so it is pinned here: a reader comparing the two files should
        // find them identical rather than merely equivalent as sets.
        expect(Object.keys(transform)).toStrictEqual([
            'posX',
            'posY',
            'posZ',
            'rot',
            'scale',
            'opacity',
            'layer',
        ]);
    });

    it('a TransformDiff is a WireTransform plus a netId, flattened', () => {
        const diff: TransformDiff = { ...transform, netId: netId(1) };
        expect(Object.keys(diff)).toHaveLength(8);
        // The intersection stays index-signature-compatible, which is what lets the highest-volume
        // type on the wire be flat. A "simplification" to a nested field would silently add two
        // braces per entity per send-tick — and would fail this assertion.
        expect(jsonCodec.encode(diff)).not.toContain('"transform"');
    });
});

// For every channel the steady-state path can modify, the snapshot must supply a baseline. That is
// the invariant most easily broken one channel at a time, because each omission looks local and the
// failure appears only on a mid-session join. This is that rule as an exhaustive Record: add a tenth
// structural op and it fails to compile, at the moment the omission is cheapest to fix.
//
// The mapping is semantic, so a human still chooses the value; only the EXHAUSTIVENESS is
// mechanical, and `null` is the deliberate escape for an op with no consumer yet.

type SnapshotBaseline =
    | 'entities'
    | 'entities[].parent'
    | 'entities[].tags'
    | 'entities[].transform'
    | 'entities[].overrides'
    | 'players'
    | 'state'
    | null;

const SNAPSHOT_COVERAGE: Record<WireStructuralOpKind, SnapshotBaseline> = {
    spawn: 'entities',
    destroy: 'entities',
    'enter-interest': 'entities',
    'leave-interest': 'entities',
    reparent: 'entities[].parent',
    tag: 'entities[].tags',
    'player-join': 'players',
    'player-leave': 'players',
    attach: 'entities[].overrides',
    // A group holds ops that each have one, and a joiner receives the world those ops built rather
    // than the ops — so the boundary itself is the one arm with nothing of its own to restate.
    group: null,
};

describe('the snapshot supplies a baseline for every channel steady state modifies', () => {
    it('every structural op names the snapshot field that carries its baseline', () => {
        const uncovered = Object.entries(SNAPSHOT_COVERAGE)
            .filter(([, field]) => field === null)
            .map(([kind]) => kind);
        expect(uncovered).toStrictEqual(['group']);
    });

    it('every named baseline is a field the snapshot actually has', () => {
        expect(Object.keys(snapshot)).toStrictEqual(['tick', 'entities', 'players', 'state']);
        expect(Object.keys(entity)).toStrictEqual([
            'netId',
            'template',
            'parent',
            'owner',
            'tags',
            'transform',
        ]);
        // Absent above, because the ordinary entity carries exactly what its template describes.
        const scripted: EntitySnapshot = {
            ...entity,
            overrides: { scripts: [{ script: 'aim' as ScriptId }] },
        };
        expect(Object.keys(scripted)).toContain('overrides');
    });

    it('ownership has a baseline, so `Entity.owner` resolves on a joiner', () => {
        // Fed from core's `EntityRecord.ownerId` at the send boundary. Undeclared, this read as
        // working while every client avatar was unowned.
        const owned: EntitySnapshot = { ...entity, owner: 'p1' };
        expect(owned.owner).toBe('p1');
        expect(entity.owner).toBeNull();
    });

    it('the transform channel’s baseline is all seven fields, none defaultable', () => {
        // A spawn that left scale/rot/opacity/layer to the transform channel loses them permanently
        // for a static entity, whose one dirty tick is the spawn itself.
        expect(Object.keys(entity.transform)).toHaveLength(7);
    });
});

// `SNAPSHOT_COVERAGE` is keyed by ARM, so it sees neither the narrowing of `template` nor the
// addition of `overrides` — both are fields on an arm that already existed. Each gets its own.

type _GroupIsMessage = Assignable<WireStructuralGroup, Message>;
type _ScriptAttachmentIsMessage = Assignable<WireScriptAttachment, Message>;
/** A group holds indivisible ops and never another group: one level, so a receiver bounds it. */
type _GroupHoldsSingleOps = Assert<
    IsMutual<WireStructuralGroup['ops'][number], WireSingleStructuralOp>
>;
type _SingleIsAStructuralOp = Assignable<WireSingleStructuralOp, WireStructuralOp>;

describe('a template instantiation crosses as one boundary', () => {
    it('holds its ops flat, parents ahead of children, and never nests a second group', () => {
        // @ts-expect-error — a nested group would make the shape recursive, and a cardinality cap
        // bounds nothing on a recursive shape without a depth cap beside it.
        const nested: WireStructuralGroup = { kind: 'group', ops: [turretGroup] };
        expect(nested.kind).toBe('group');

        const spawns = turretGroup.ops.filter((op) => op.kind === 'spawn');
        expect(spawns.map((op) => op.snapshot.netId)).toStrictEqual([20, 21]);
        // The reparent that hangs the barrel off the turret comes after both spawns, or the client
        // would parent to a netId it does not hold.
        expect(turretGroup.ops.at(-1)?.kind).toBe('reparent');
    });

    it('encodes, so the boundary costs one nesting level and no more', () => {
        expect(() => jsonCodec.encode(turretGroup)).not.toThrow();
    });
});

describe('a spawn names its template by authoring id, and what it overrides', () => {
    it('refuses a bare string where a TemplateId belongs', () => {
        // @ts-expect-error — a free string is what `template` used to be, and it is exactly what a
        // renamed template leaves behind: the brand is what makes the rename a compile error.
        const loose: EntitySnapshot = { ...entity, template: 'wall' };
        expect(loose.template).toBe('wall');
        // At runtime it is the same string the render manifest is keyed by, and nothing more.
        expect(jsonCodec.encode({ template: entity.template })).toBe('{"template":"wall"}');
    });

    it('omits `overrides` for an entity its template describes whole', () => {
        expect('overrides' in entity).toBe(false);
        // Absent, never explicitly undefined — the codec refuses the latter.
        const dynamic = { ...entity, overrides: undefined } as unknown as Message;
        expect(() => jsonCodec.encode(dynamic)).toThrow();
    });

    it('carries the attachments a joiner cannot infer, with the props they were configured with', () => {
        const overrides: EntityOverrides = {
            scripts: [{ script: scriptId('aim'), props: { range: 120 } }],
        };
        const scripted: EntitySnapshot = { ...entity, overrides };
        expect(String(jsonCodec.encode(scripted))).toContain('"script":"aim"');
        expect(String(jsonCodec.encode(scripted))).toContain('"range":120');
    });

    it('names a script by the id the bundle stamped, never by a class name', () => {
        // A minifier rewrites `class Aim` and rewrites neither the manifest nor the wire, so the
        // name is no contract across a build — let alone across two processes.
        const attach = turretGroup.ops.find((op) => op.kind === 'attach');
        expect(attach && 'script' in attach).toBe(true);
        expect(attach && 'scriptClass' in attach).toBe(false);
    });
});

describe('the render manifest is keyed by authoring ids on both sides of each join', () => {
    it('refuses a bare string where the id a spawn keys the manifest by belongs', () => {
        // @ts-expect-error — the other end of `EntitySnapshot.template`, unbranded here until now.
        const loose: TemplateVisual = { template: 'coin', kind: 'group' };
        expect(loose.template).toBe('coin');
    });

    it('refuses a bare string where the key a texture resolves through belongs', () => {
        // @ts-expect-error — a sprite's `texture` is an AssetId, so the entry it names must be one.
        const dangling: WireAssetRef = { key: 'coin', kind: 'texture', url: '/coin.png' };
        expect(dangling.key).toBe('coin');
    });
});

// Wrapper state is not a structural op, so `SNAPSHOT_COVERAGE` is blind to it — a fifth wrapper
// would replicate through `state` with nobody having decided how it crosses. This is the same rule
// in the shape wrapper payloads have: exhaustive over the kinds, with the answer written down.

/** What a receiver holding no scripts must be able to rebuild the class from. */
type WrapperRebuild = 'tag alone' | 'tag + order' | 'tag + name' | 'tag + player';

const WRAPPER_COVERAGE: Record<WireWrapperKind, WrapperRebuild> = {
    Scoreboard: 'tag alone',
    // The order decides what `top` means, so defaulting it inverts a low-is-better board.
    Leaderboard: 'tag + order',
    Team: 'tag + name',
    // Resolved through the roster; an inventory naming a player this world lacks stays raw.
    Inventory: 'tag + player',
};

type _WrapperKindMatchesCore = Assert<IsMutual<WireWrapperKind, WrapperKind>>;
/** Every arm of the payload union is one of the declared kinds, and every kind has an arm. */
type _WrapperStateCoversEveryKind = Assert<IsMutual<WireWrapperState['kind'], WireWrapperKind>>;
type _WrapperStateIsMessage = Assignable<WireWrapperState, Message>;

describe('wrapper state crosses as a tagged payload, not as a class', () => {
    it('every wrapper kind names what rebuilding it takes', () => {
        expect(Object.keys(WRAPPER_COVERAGE).toSorted()).toStrictEqual([
            'Inventory',
            'Leaderboard',
            'Scoreboard',
            'Team',
        ]);
    });

    it('carries every constructor argument, since the receiver runs no scripts', () => {
        const team: WireWrapperState = { kind: 'Team', name: 'red', members: ['p1'] };
        const board: WireWrapperState = {
            kind: 'Leaderboard',
            order: 'low',
            scores: [['p1', 30]],
        };
        expect(Object.keys(team)).toContain('name');
        expect(Object.keys(board)).toContain('order');
    });

    it('carries maps as entry pairs, so a creator-chosen name never lands in key position', () => {
        // An inventory item called `__proto__` as a KEY would make the codec refuse the whole frame;
        // as the first half of a pair it is an ordinary string.
        const bag: WireWrapperState = {
            kind: 'Inventory',
            player: 'p1',
            items: [['__proto__', 1]],
        };
        expect(() => jsonCodec.encode({ fields: { bag } })).not.toThrow();
    });

    it('rides a StateDiff field, so it is bounded by the same reserved-key rule as any value', () => {
        const diff = {
            host: { kind: 'game' },
            fields: { scores: { kind: 'Scoreboard', scores: [['p1', 7]] } },
        };
        expect(() => jsonCodec.encode({ state: [diff] })).not.toThrow();
    });
});

describe('state diffs group under one host address', () => {
    it('names the host once however many fields it wrote', () => {
        const grouped = String(jsonCodec.encode({ state: stateEnvelope.state }));
        expect(grouped.match(/"host"/g)).toHaveLength(1);

        // The shape it replaced repeated the whole address per field.
        const perField = String(
            jsonCodec.encode({
                state: [
                    { host: { kind: 'player', id: 'p1' }, field: 'coins', value: 7 },
                    { host: { kind: 'player', id: 'p1' }, field: 'lives', value: 3 },
                ],
            }),
        );
        expect(perField.match(/"host"/g)).toHaveLength(2);
        expect(perField.length).toBeGreaterThan(grouped.length);
    });

    it('a reserved field name is refused on decode, because names are keys now', () => {
        // The security half of the regrouping, and the reason to prefer keys over a `field` string:
        // the codec already refuses a reserved KEY, so a hostile server cannot hand the client one.
        const hostile =
            '{"kind":"state","tick":1,"ackSeq":0,"structural":[],"state":[{"host":{"kind":"game"},"fields":{"__proto__":{"polluted":true}}}]}';
        expect(() => jsonCodec.decode(hostile)).toThrow();

        // The shape it replaced put the name in VALUE position, where that check cannot see it — this
        // decoded clean and left the client's apply as the only thing standing in the way.
        const perField =
            '{"kind":"state","tick":1,"ackSeq":0,"structural":[],"state":[{"host":{"kind":"game"},"field":"__proto__","value":{"polluted":true}}]}';
        expect(() => jsonCodec.decode(perField)).not.toThrow();
    });
});

describe('NetId is not interchangeable with a raw number or a local handle', () => {
    it('is a number at runtime and an opaque handle at compile time', () => {
        // Numerically a NetId IS the server's EntityId, cast at the send boundary — so the brand
        // costs nothing at runtime and the wire carries a plain number.
        expect(typeof netId(16_777_216)).toBe('number');
        expect(jsonCodec.encode({ netId: netId(42) })).toBe('{"netId":42}');
    });

    it('a raw number is not a NetId, and a NetId is not core’s EntityId', () => {
        // @ts-expect-error — a raw number cannot pass as a NetId.
        const fromRaw: NetId = 42;
        // @ts-expect-error — nor can core's EntityId, which is the correctness bug the brand
        // prevents: the two runtimes hold different handles for the same entity.
        const fromEntityId: NetId = 16_777_216 as EntityId;
        expect([fromRaw, fromEntityId]).toHaveLength(2);
    });
});

describe('the three type-level rules bite where they are meant to', () => {
    it('optional means absent, never an explicit undefined', () => {
        const held: string | undefined = undefined;
        // @ts-expect-error — `exactOptionalPropertyTypes`: the fix is to OMIT the key, which is the
        // trap a reconnect path falls into when it writes `token: heldToken`.
        const withUndefined: JoinRequest = { ...joinRequest, token: held };
        expect(withUndefined.kind).toBe('join-request');
        expect('token' in joinRequest).toBe(false);

        // The runtime backstop. The cast is the test: the compile error only fires on a literal, so
        // a value assembled dynamically — the case a socket actually produces — reaches the codec,
        // which throws because `JSON.stringify` would have dropped the key silently.
        const dynamic = { ...joinRequest, token: undefined } as unknown as Message;
        expect(() => jsonCodec.encode(dynamic)).toThrow();
    });

    it('a readonly array is not assignable to the wire', () => {
        const frozen: readonly string[] = ['solid'];
        // @ts-expect-error — `readonly string[]` is not assignable to `JsonValue[]`.
        const withReadonly: EntitySnapshot = { ...entity, tags: frozen };
        expect(withReadonly.tags).toStrictEqual(['solid']);
    });

    it('an interface of the same shape is not assignable, but a type alias is', () => {
        // The gotcha that makes "envelopes are `type`, never `interface`" a rule rather than a
        // style: an interface gets no implicit index signature.
        interface AsInterface {
            kind: 'state';
            tick: number;
        }
        type AsTypeAlias = { kind: 'state'; tick: number };
        // @ts-expect-error — no implicit index signature on an interface.
        type _InterfaceFails = Assignable<AsInterface, Message>;
        type _AliasPasses = Assignable<AsTypeAlias, Message>;

        // The restriction is purely compile-time — the same bytes encode either way, which is why
        // nothing at runtime catches an `interface` slipping onto the wire.
        const asInterface: AsInterface = { kind: 'state', tick: 1 };
        const asAlias: AsTypeAlias = { kind: 'state', tick: 1 };
        expect(jsonCodec.encode(asInterface as unknown as Message)).toBe(jsonCodec.encode(asAlias));
    });
});

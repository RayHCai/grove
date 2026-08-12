// A types-only package's meaningful tests are compile-time ones: `tsc -p tsconfig.test.json` is the
// real assertion, and the `expect` calls exist so a reader sees which invariant broke rather than
// one long list of TS errors.

import { describe, expect, it } from 'vitest';
import type { Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
// Type-only, and reachable from tests alone: `@platform/core` is a devDependency and a reference of
// `tsconfig.test.json` only, so the parity checks below pin the restated types without core
// appearing in any shipped module graph.
import type { AssetKind, EntityId, EventPhase, TransformBuffer } from '@platform/core';
import type {
    ClientToServer,
    EntitySnapshot,
    Envelope,
    InputFrame,
    InputPhase,
    JoinRequest,
    NetId,
    RateChange,
    Reject,
    ServerToClient,
    StateEnvelope,
    TimeSync,
    TimeSyncReply,
    TransformDiff,
    TransformEnvelope,
    Welcome,
    WireAssetKind,
    WireStructuralOp,
    WireStructuralOpKind,
    WireTransform,
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
    template: 'wall',
    parent: null,
    owner: null,
    tags: ['solid'],
    transform,
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
    simRate: 60,
    sendRate: 20,
    bounds: { left: -100, right: 100, top: 100, bottom: -100 },
    regions: [{ name: 'arena', bounds: { left: -10, right: 10, top: 10, bottom: -10 } }],
    clientSentMs: 1000,
    serverSentMs: 1050,
    snapshot,
    visuals: {
        assets: [
            { key: 'coin', kind: 'texture', url: 'coin.png', meta: { width: 16, height: 16 } },
        ],
        templates: [
            { template: 'coin', kind: 'sprite', texture: 'coin', anchorX: 0.5, anchorY: 0.5 },
            { template: 'spawner', kind: 'group' },
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
    structural: [{ kind: 'spawn', snapshot: entity }],
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
};

const inputFrame: InputFrame = {
    kind: 'input',
    tick: 4821,
    seq: 337,
    actions: [{ action: 'jump', on: 'press' }],
};

const timeSync: TimeSync = { kind: 'time-sync', clientSentMs: 9 };

// The rule that makes the whole vocabulary usable, and the one whose failures read like nothing to
// do with design: they surface at the `send` call as assignability errors.

type _JoinRequestIsMessage = Assignable<JoinRequest, Message>;
type _WelcomeIsMessage = Assignable<Welcome, Message>;
type _RejectIsMessage = Assignable<Reject, Message>;
type _StateIsMessage = Assignable<StateEnvelope, Message>;
type _TransformIsMessage = Assignable<TransformEnvelope, Message>;
type _TimeSyncIsMessage = Assignable<TimeSync, Message>;
type _TimeSyncReplyIsMessage = Assignable<TimeSyncReply, Message>;
type _RateChangeIsMessage = Assignable<RateChange, Message>;
type _InputFrameIsMessage = Assignable<InputFrame, Message>;
type _ServerToClientIsMessage = Assignable<ServerToClient, Message>;
type _ClientToServerIsMessage = Assignable<ClientToServer, Message>;

// The payload types too: a `readonly` or an `interface` slipped into one of these otherwise fails at
// the envelope, which is harder to read.
type _StructuralOpIsMessage = Assignable<WireStructuralOp, Message>;
type _TransformDiffIsMessage = Assignable<TransformDiff, Message>;
type _SnapshotIsMessage = Assignable<WorldSnapshot, Message>;

const serverFrames: ServerToClient[] = [
    welcome,
    reject,
    stateEnvelope,
    transformEnvelope,
    timeSyncReply,
    rateChange,
];
const clientFrames: ClientToServer[] = [joinRequest, inputFrame, timeSync];

describe('every envelope is assignable to transport Message', () => {
    it('encodes through jsonCodec, which is the runtime half of the same rule', () => {
        // `jsonCodec.encode` throws on anything JSON would silently drop or transform, so a shape
        // that satisfies the compiler and not the wire is caught here.
        const frames: Envelope[] = [...serverFrames, ...clientFrames];
        for (const frame of frames) {
            expect(() => jsonCodec.encode(frame)).not.toThrow();
        }
        expect(frames).toHaveLength(9);
    });

    it('round-trips an envelope to a structurally equal value', () => {
        expect(jsonCodec.decode(jsonCodec.encode(welcome))).toStrictEqual(welcome);
    });
});

// What the discriminant buys: narrowing is a compiler-checked exhaustive switch, and an unknown
// message is a clean rejection rather than a misparse. The `never` in each default is the assertion
// — add a tenth message and the arm stops compiling.

function narrowServerToClient(frame: ServerToClient): string {
    switch (frame.kind) {
        case 'welcome':
            return `welcome@${frame.snapshot.tick}`;
        case 'reject':
            return `reject:${frame.reason}`;
        case 'state':
            return `state@${frame.tick}/${frame.ackSeq}`;
        case 'transform':
            return `transform@${frame.tick}`;
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
            'reject:version',
            'state@4821/337',
            'transform@4821',
            'sync@3',
            'rate@30',
        ]);
    });

    it('narrows every client-to-server arm', () => {
        expect(clientFrames.map(narrowClientToServer)).toStrictEqual([
            'join:Ray',
            'input@4821/337',
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
        expect(new Set([...serverKinds, ...clientKinds]).size).toBe(9);
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
    // The client instantiates no scripts yet. When it does, this null is what says
    // `EntitySnapshot` needs a `scripts: string[]` — the same omission, caught by the same rule.
    attach: null,
};

describe('the snapshot supplies a baseline for every channel steady state modifies', () => {
    it('every structural op names the snapshot field that carries its baseline', () => {
        const uncovered = Object.entries(SNAPSHOT_COVERAGE)
            .filter(([, field]) => field === null)
            .map(([kind]) => kind);
        expect(uncovered).toStrictEqual(['attach']);
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

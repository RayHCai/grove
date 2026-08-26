// Types only, one dependency: both endpoints agree here and nowhere else.

export const PACKAGE_NAME = '@platform/protocol';

export type { NetId, PlayerId } from './ids.js';
export { PROTOCOL_VERSION } from './version.js';

export type { ClientToServer, Envelope, EnvelopeKind, ServerToClient } from './envelopes.js';

export type { JoinRequest, Reject, RejectReason, Welcome } from './envelopes.js';

export type {
    StateDiff,
    StateEnvelope,
    StateHostAddr,
    TransformDiff,
    TransformEnvelope,
    WireStructuralOp,
    WireStructuralOpKind,
    WireTransform,
} from './envelopes.js';

export type {
    EntitySnapshot,
    GroupTemplateChild,
    GroupTemplateVisual,
    PlayerSnapshot,
    RenderManifest,
    SpriteTemplateChild,
    SpriteTemplateVisual,
    TemplateChild,
    TemplateVisual,
    WireAssetKind,
    WireAssetRef,
    WireBounds,
    WireRegion,
    WorldSnapshot,
} from './envelopes.js';

export type { RateChange, TimeSync, TimeSyncReply } from './envelopes.js';

export type { InputAction, InputFrame, InputPhase } from './envelopes.js';

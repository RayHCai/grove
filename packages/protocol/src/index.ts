// Types only, one dependency: both endpoints agree here and nowhere else.

export const PACKAGE_NAME = '@platform/protocol';

export type { NetId, PlayerId, ProjectId } from './ids.js';
export { PROTOCOL_VERSION } from './version.js';

export type { ClientToServer, Envelope, EnvelopeKind, ServerToClient } from './envelopes.js';

export type { JoinRequest, Reject, RejectReason, SnapshotChunk, Welcome } from './envelopes.js';

export type {
    EntityOverrides,
    StateDiff,
    StateEnvelope,
    StateHostAddr,
    TransformDiff,
    TransformEnvelope,
    WireScriptAttachment,
    WireSingleStructuralOp,
    WireStructuralGroup,
    WireStructuralOp,
    WireStructuralOpKind,
    WireTransform,
    WireWrapperKind,
    WireWrapperState,
} from './envelopes.js';

export type {
    EntitySnapshot,
    GroupTemplateChild,
    GroupTemplateVisual,
    PlayerSnapshot,
    ManifestUpdate,
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

export type { Interaction, InteractionFrame, InteractionKind } from './envelopes.js';

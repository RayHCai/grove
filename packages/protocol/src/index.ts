// Types only, one dependency: both endpoints agree here and nowhere else.

export type { NetId, PlayerId, ProjectId } from './ids.js';
export { PROTOCOL_VERSION } from './version.js';

export type { ClientToServer, Envelope, ServerToClient } from './envelopes.js';

export type {
    JoinRequest,
    ManifestUpdate,
    Reject,
    RejectReason,
    SnapshotChunk,
    Welcome,
} from './envelopes.js';

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

export type { Interaction, InteractionFrame } from './envelopes.js';

export type { GameRequest, RequestFrame } from './envelopes.js';

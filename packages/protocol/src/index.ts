// Types, plus the values and the client-frame rules both endpoints must agree on: here and nowhere else.

export type { NetId, PlayerId, ProjectId } from './ids.js';
export { PROTOCOL_VERSION } from './version.js';
export {
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_IDENTITY_LENGTH,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_NAME_LENGTH,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_WIDGET_NAME_LENGTH,
} from './limits.js';
export {
    asClientEnvelope,
    isActionName,
    isAdmissiblePayload,
    isRequestName,
    isWidgetName,
} from './validate.js';

export type { ClientToServer, ServerToClient } from './envelopes.js';

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

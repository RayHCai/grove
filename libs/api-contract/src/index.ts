// The token signer is deliberately absent: it reaches node:crypto, and these shapes are parsed in a
// browser. It is at @grove/api-contract/tokens, the way transport keeps its socket behind a
// subpath.
export { ContentHash, GameId, HostId, InstanceId, PlayerId, SessionId, TaskId } from './ids.js';
export { Account, Game, GameUpdate, GameVisibility, Profile, SignedIn } from './accounts.js';
export { ErrorBody } from './errors.js';
export { PlayHandoff, PlayRequestParams, PlaySession } from './allocator.js';
export {
    BundleRef,
    BundleSet,
    ConfigRef,
    LeaderboardEntry,
    LeaderboardPage,
    LeaderboardQuery,
    LeaderboardWrite,
    StateKeyParams,
    StateRecord,
    StateValue,
    StateWrite,
} from './game-data.js';
export {
    Deployment,
    DeploymentRequest,
    FleetEvent,
    FleetEventKind,
    FleetReport,
    HostCapacity,
    HostDeployment,
    HostHeartbeat,
    HostLiveness,
    HostView,
    InstanceReport,
    InstanceStart,
    Placement,
    PlacementRequest,
} from './placement.js';
export {
    BuildDiagnostic,
    Task,
    TaskDetail,
    TaskKind,
    TaskMessage,
    TaskStatus,
    TaskStatusUpdate,
    isTerminal,
    streamOf,
} from './tasks.js';
export {
    AssetUpload,
    AssetUploadRequest,
    FileKind,
    MAX_ASSET_BYTES,
    MAX_SOURCE_BYTES,
    MAX_WORKSPACE_FILES,
    Manifest,
    MediaType,
    PlayableVersion,
    PublishedVersion,
    SourceUpsert,
    VersionId,
    Workspace,
    WorkspaceFile,
    WorkspacePath,
    WorkspaceSave,
    buildPrefix,
    encodeManifest,
    manifestKey,
    objectKey,
} from './workspace.js';
export { REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH, validRequestId } from './request-id.js';

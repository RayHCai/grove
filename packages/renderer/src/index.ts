// Must not import `pixi.js`, transitively either: server tooling and type emission import the
// interface from here and must not drag a WebGL library into their module graph.

export type {
    IRenderer,
    RendererInitOptions,
    RendererEvents,
    Surface,
    Framing,
    ScaleMode,
    TextureFilter,
    ContextState,
    UiAnchor,
    CameraState,
    AssetManifestEntry,
    AssetInfo,
    AssetFailure,
    AssetLoadResult,
    AssetUnloadResult,
    TextStyle,
    NodeDesc,
    SpriteNodeDesc,
    GroupNodeDesc,
    TextNodeDesc,
    SubtreeNodeDesc,
    NodePatch,
    Transform,
    NodeSnapshot,
    SceneSnapshot,
    InspectOptions,
    PickOptions,
} from './renderer.js';

export type { NodeId } from './node-id.js';
export { NO_NODE } from './node-id.js';

// `RendererError` is the class every throwing member of `IRenderer` uses, so a caller needs it to
// write an `instanceof` check.
export type { RendererErrorCode } from './errors.js';
export { RendererError } from './errors.js';

// The client validates a server-supplied manifest before it reaches the renderer; a second copy of
// the scheme check is how the two policies drift apart. `AssetQueue` is exported for the same
// reason: it is the per-name intent map a mid-session manifest addition merges against, and a
// second one written in `@platform/client` would be a second answer to "is this already loaded".
export { AssetQueue, isAllowedAssetUrl, REMOTE_ASSET_SCHEMES } from './asset-queue.js';
export type { AssetIntent, MergedAssetWork } from './asset-queue.js';

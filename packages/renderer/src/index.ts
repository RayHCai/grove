// Must not import `pixi.js`, transitively either: server tooling and type emission import the
// interface from here and must not drag a WebGL library into their module graph.

export const PACKAGE_NAME = '@platform/renderer';

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
    NodePatch,
    Transform,
    NodeSnapshot,
    SceneSnapshot,
    InspectOptions,
} from './renderer.js';

export type { NodeId } from './node-id.js';
export { NO_NODE, INDEX_RANGE, MAX_INDEX, MAX_GENERATION } from './node-id.js';

export type { RendererErrorCode } from './errors.js';
export { RendererError } from './errors.js';

export {
    SURFACE_ORDER,
    DEFAULT_SURFACES,
    surfaceOrder,
    isCameraTransformed,
    isScreenSpace,
    isSurface,
} from './surfaces.js';

// The engine computes `camera.viewport` and the editor hit-tests in world space; re-deriving
// either from the renderer's numbers is how the two drift apart.
export { fitScale, isLetterboxed, stageRect, visibleRect, worldViewport } from './viewport.js';

export {
    cameraScale,
    pixiRotation,
    worldToScreen,
    screenToWorld,
    uiAnchorOrigin,
    uiToScreen,
    flipY,
} from './projection.js';

export { DEFAULT_CULL_MARGIN } from './bounds.js';

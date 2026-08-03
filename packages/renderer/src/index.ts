// @platform/renderer
// IRenderer interface and the PixiJS implementation.
//
// THIS BARREL MUST NOT IMPORT `pixi.js`, directly or transitively (§13). Anything that only
// touches the TYPE — server-side tooling, the panel's type emission — imports from here and
// must not drag a WebGL library into its module graph. The backends live behind subpath
// exports: `@platform/renderer/pixi` and `@platform/renderer/null`.

export const PACKAGE_NAME = '@platform/renderer';

// ─── the contract ───────────────────────────────────────────────────

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

// ─── handles ────────────────────────────────────────────────────────

export type { NodeId } from './node-id.js';
export { NO_NODE, INDEX_RANGE, MAX_INDEX, MAX_GENERATION } from './node-id.js';

// ─── errors ─────────────────────────────────────────────────────────

export type { RendererErrorCode } from './errors.js';
export { RendererError } from './errors.js';

// ─── surfaces ───────────────────────────────────────────────────────

export {
    SURFACE_ORDER,
    DEFAULT_SURFACES,
    surfaceOrder,
    isCameraTransformed,
    isScreenSpace,
    isSurface,
} from './surfaces.js';

// ─── pure math the engine and editor also need ──────────────────────
//
// `viewport` and `projection` are exported because the engine computes `camera.viewport`
// (api_spec.ts:314) and the editor hit-tests in world space; re-deriving either from the
// renderer's numbers is how the two drift apart.

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

// The backend-neutral renderer contract (§11). Nothing here names a Pixi type, so a
// second backend is a new folder under src/ rather than a rewrite.

import type { MutableVec3, Vec3Like, Bounds, Size } from '@platform/math';
import type { NodeId } from './node-id.js';

// ─── surfaces, modes ────────────────────────────────────────────────

/**
 * One of the five draw roots. Order is fixed bottom-to-top and is NOT configurable —
 * a sixth surface would be an API version, not a runtime argument (§4).
 */
export type Surface = 'editorSpace' | 'world' | 'ui' | 'editorOverlay' | 'editorUi';

/** `'free'` is the infinite editor canvas: `fitScale` is 1 and nothing letterboxes (§4.1). */
export type Framing = 'stage' | 'free';

/** How the design stage maps onto the canvas (§4.2). `stretch` is deliberately absent. */
export type ScaleMode = 'fit' | 'fill' | 'expand';

export type TextureFilter = 'nearest' | 'linear';

export type ContextState = 'ok' | 'lost' | 'restoring';

/** Mirrors `HUDAnchor`, api_spec.ts:67. */
export type UiAnchor =
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'middle-left'
    | 'center'
    | 'middle-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';

/**
 * The camera shared by all three camera-transformed surfaces — which is what makes an
 * editor gizmo register with the entity it is attached to (§4).
 */
export interface CameraState {
    position: Vec3Like;
    zoom: number;
    framing?: Framing;
}

// ─── init ───────────────────────────────────────────────────────────

export interface RendererInitOptions {
    container: HTMLElement;
    /** The reference stage, in world px. UI is authored against this size (§3). */
    design: Size;
    /** Default `['world', 'ui']` — a shipped game allocates no editor containers. */
    enabledSurfaces?: readonly Surface[];
    /** Default `'fit'`. */
    scaleMode?: ScaleMode;
    /** Default `true`. Applies under `'fit'` only; forced off under `'free'` framing. */
    letterbox?: boolean;
    background?: number | 'transparent';
    /** DPR cap. Default 2. */
    maxResolution?: number;
    /** Default `'nearest'` — kid-drawn pixel art. */
    defaultFilter?: TextureFilter;
    /** Default `false`. */
    antialias?: boolean;
    /** Default `true` — an internal `ResizeObserver` on `container`. */
    autoResize?: boolean;
    /** WORLD px of slack added to the viewport before the cull test. Default 64 (§8). */
    cullMargin?: number;
    /** Default `'webgl'`. Both loss paths are handled either way. */
    preference?: 'webgl' | 'webgpu';
}

// ─── assets ─────────────────────────────────────────────────────────

export type AssetManifestEntry =
    | { name: string; kind: 'image'; url: string; filter?: TextureFilter; size?: Size }
    | { name: string; kind: 'atlas'; url: string; filter?: TextureFilter }
    | { name: string; kind: 'font'; url: string; family?: string }
    | { name: string; kind: 'text'; text: string; style?: TextStyle };

export interface AssetInfo {
    name: string;
    size: Size;
}

export interface AssetFailure {
    name: string;
    reason: string;
}

/** `loadAssets` resolves with this rather than rejecting — one 404 must not kill a level. */
export interface AssetLoadResult {
    loaded: AssetInfo[];
    failed: AssetFailure[];
    /** `true` when the work was deferred past a context loss (§10). */
    queued: boolean;
}

export interface AssetUnloadResult {
    unloaded: string[];
    /** Never loaded. Not an error — idempotent teardown needs no guard. */
    unknown: string[];
    /** Unloaded anyway; affected nodes show the placeholder. Fonts are kept instead (§9.2). */
    inUse: Array<{ name: string; nodeCount: number }>;
    queued: boolean;
}

// ─── nodes ──────────────────────────────────────────────────────────

export interface TextStyle {
    font?: string;
    size?: number;
    /** `0xRRGGBB`. */
    color?: number;
    align?: 'left' | 'center' | 'right';
    weight?: 'normal' | 'bold';
    italic?: boolean;
    stroke?: { color: number; width: number };
    wrapWidth?: number;
    lineHeight?: number;
    /** Raster scale for text assets — the caller's explicit answer to zoom blur (§9.3). */
    resolution?: number;
}

interface NodeBase {
    /** Default `'world'`. Immutable after create. */
    surface?: Surface;
    /** Default `NO_NODE` — a root of its surface. */
    parent?: NodeId;

    // INHERITED by children (§5)

    /** LOCAL to `parent`. */
    position?: Vec3Like;
    visible?: boolean;

    // NOT inherited — these stop at the node that declares them (§5)

    /** Degrees, CCW-positive. */
    rotation?: number;
    /** Per-axis, default 1. Negative x is a horizontal flip. */
    scale?: Vec3Like;
    /** 0..1. */
    alpha?: number;
    tint?: number;

    /** 0..1 pivot INSIDE this node's own art — not hierarchy. Default centered (0.5, 0.5). */
    anchor?: Vec3Like;
    /** Draw order within the surface; sibling order once parented. */
    layer?: number;
    /** For visuals that exceed their bounds — glow, thick stroke, emitter. */
    neverCull?: boolean;
    /** UI-surface roots only. `position` is then the offset from this anchor. */
    uiAnchor?: UiAnchor;
}

export interface SpriteNodeDesc extends NodeBase {
    kind: 'sprite';
    texture: string;
}

/** A positional pivot with no art. Its rotation/scale/alpha/tint are inert (§6.2). */
export interface GroupNodeDesc extends NodeBase {
    kind: 'group';
}

/** UI surfaces ONLY. World text goes through `createTextAsset` (§9.3). */
export interface TextNodeDesc extends NodeBase {
    kind: 'text';
    text: string;
    style?: TextStyle;
}

export type NodeDesc = SpriteNodeDesc | GroupNodeDesc | TextNodeDesc;

/** An `undefined` field means unchanged. Nothing is retained past the call (§11.1). */
export interface NodePatch {
    id: NodeId;
    parent?: NodeId;
    position?: Vec3Like;
    rotation?: number;
    scale?: Vec3Like;
    anchor?: Vec3Like;
    alpha?: number;
    visible?: boolean;
    tint?: number;
    layer?: number;
    /** Sprite nodes only. Ignored with a dev warning elsewhere. */
    texture?: string;
    /** UI text nodes only. */
    text?: string;
}

/**
 * A node's transform. Returned by both `localTransformOf` and `resolvedTransformOf` for
 * uniformity; only `position` and `visible` can differ between them, because rotation,
 * scale and alpha do not inherit (§6.1).
 */
export interface Transform {
    position: MutableVec3;
    rotation: number;
    scale: MutableVec3;
    alpha: number;
    visible: boolean;
}

// ─── inspection (dev/tooling) ───────────────────────────────────────

/**
 * One node, as a debugger sees it. A PLAIN SNAPSHOT — every field is a copy, so holding one
 * cannot mutate the scene and reading one later cannot observe a change (§11.2).
 *
 * `parent` is `NO_NODE` for a surface root. `children` is in draw order, same rule as
 * {@link SceneSnapshot.roots}.
 */
export interface NodeSnapshot {
    id: NodeId;
    kind: 'sprite' | 'group' | 'text';
    surface: Surface;
    layer: number;
    /** Asset name for a sprite; `''` for group and text. */
    texture: string;
    /** Current string for a text node; `''` otherwise. */
    text: string;
    uiAnchor: UiAnchor | undefined;
    parent: NodeId;
    children: NodeId[];
    /** LOCAL to `parent`. */
    local: Transform;
    /** After inheritance — position and visibility only, since nothing else inherits (§5). */
    resolved: Transform;
    /** `null` for a group, which has no art and therefore no extent (§8). */
    localBounds: Bounds | null;
    /** Rotated AABB, world space. `null` for a group. */
    worldBounds: Bounds | null;
    /** What the last `render()` decided. Groups, UI and `neverCull` nodes are never culled. */
    culled: boolean;
    /** `true` when this node's texture name is not resident, so it draws the placeholder. */
    missingTexture: boolean;
}

/** What {@link IRenderer.inspect} returns. */
export interface SceneSnapshot {
    /** Root ids per surface, in draw order. Only enabled surfaces appear as keys. */
    roots: Partial<Record<Surface, NodeId[]>>;
    /** Every live node, keyed by id. Flat, so a consumer walks `roots` + `children` itself. */
    nodes: Map<NodeId, NodeSnapshot>;
    /** Enabled surfaces, bottom to top, with their current visibility. */
    surfaces: Array<{ surface: Surface; visible: boolean }>;
    camera: CameraState;
    canvas: Size;
    /** Screen space, y-down. */
    stageRect: Bounds;
    /** World space, y-up (`top > bottom`). */
    viewport: Bounds;
    resolution: number;
    contextState: ContextState;
    /** Resident asset names with their sizes. */
    assets: Array<{ name: string; size: Size }>;
    counts: { nodes: number; culled: number; surfaces: number; assets: number };
}

export interface InspectOptions {
    /** Restrict to one surface. Default: every enabled surface. */
    surface?: Surface;
    /**
     * Omit `localBounds`/`worldBounds`, which need a size lookup per node. Default `false`;
     * pass `true` when polling a large scene and only the hierarchy matters.
     */
    skipBounds?: boolean;
}

// ─── events ─────────────────────────────────────────────────────────

export interface RendererEvents {
    contextlost: { reason: string };
    contextrestored: { reloadedAssets: string[]; failedAssets: string[] };
    resize: { canvas: Size; stage: Bounds; viewport: Bounds; resolution: number };
}

// ─── the interface ──────────────────────────────────────────────────

/**
 * The renderer contract. An interface with per-backend factories
 * (`createPixiRenderer()`, `createNullRenderer()`) rather than an abstract class: no
 * inheritance coupling, no runtime import needed to reference the type, and a mock is one
 * object literal (§11.1).
 */
export interface IRenderer {
    readonly initialized: boolean;
    readonly contextState: ContextState;
    /** Observability during a context loss. */
    readonly pendingAssetOps: number;

    init(options: RendererInitOptions): Promise<void>;
    destroy(): void;

    // sizing

    resize(cssWidth: number, cssHeight: number): void;
    readonly canvasSize: Readonly<Size>;
    /** The DPR actually in use, after the `maxResolution` cap. */
    readonly resolution: number;
    /** The letterboxed stage, screen space (y-down). */
    readonly stageRect: Readonly<Bounds>;
    /** World space, y-up (`top > bottom`). This is what feeds `camera.viewport`. */
    readonly viewport: Bounds;

    // surfaces

    setSurfaceVisible(surface: Surface, visible: boolean): void;
    isSurfaceEnabled(surface: Surface): boolean;

    // assets — async, uniform AssetInfo; queued while the context is lost

    loadAsset(entry: AssetManifestEntry): Promise<AssetInfo>;
    loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult>;
    unloadAssets(entries: readonly (string | AssetManifestEntry)[]): Promise<AssetUnloadResult>;
    createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo>;
    /** INTENDED state, post-queue — never raw GPU state (§10). */
    hasAsset(name: string): boolean;
    getAssetSize(name: string): Readonly<Size> | null;

    // nodes — store ops; always immediate, even during a context loss (§10)

    /** Synchronous by design: `game.spawn` is specified sync and always safe (§9.1). */
    createNode(desc: NodeDesc): NodeId;
    createNodes(descs: readonly NodeDesc[], out?: NodeId[]): NodeId[];
    createNodeAsync(desc: NodeDesc): Promise<{ id: NodeId } & AssetInfo>;
    /** Cascades to children, matching `Entity.destroy()` (api_spec.ts:256). */
    destroyNode(id: NodeId): void;
    destroyNodes(ids: readonly NodeId[]): void;
    updateNodes(patches: readonly NodePatch[]): void;
    /** Set-only fan-out. Establishes no inheritance (§5.1). */
    updateSubtree(
        root: NodeId,
        patch: Omit<NodePatch, 'id' | 'parent'>,
        opts?: { includeRoot?: boolean },
    ): void;
    /** UI text nodes only — world text is an asset (§9.3). */
    setNodeText(id: NodeId, text: string): void;
    isAlive(id: NodeId): boolean;
    /** Drops nodes; keeps the canvas and every loaded asset. */
    clear(surface?: Surface): void;

    // hierarchy — position and visibility only (§5)

    /** `keepResolvedPosition` defaults to `false`: position becomes local to parent. */
    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void;
    /** `keepResolvedPosition` defaults to `true`: keeps world position. */
    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void;
    /** `NO_NODE` when the node is a root. */
    parentOf(id: NodeId): NodeId;
    childrenOf(id: NodeId, out?: NodeId[]): NodeId[];
    surfaceOf(id: NodeId): Surface | null;

    // camera

    setCamera(camera: Readonly<CameraState>): void;
    readonly camera: Readonly<CameraState>;

    // transforms & bounds — our store answers these, never the backend (§6)

    localTransformOf(id: NodeId, out?: Transform): Transform | null;
    resolvedTransformOf(id: NodeId, out?: Transform): Transform | null;
    localBoundsOf(id: NodeId): Bounds | null;
    /** Rotated AABB in world space — culling and editor selection (§8). */
    worldBoundsOf(id: NodeId): Bounds | null;
    /** Screen space, for UI hit-testing (§12.4). */
    screenBoundsOf(id: NodeId): Bounds | null;
    screenPositionOf(id: NodeId, out?: MutableVec3): MutableVec3 | null;
    worldToScreen(point: Vec3Like, out?: MutableVec3): MutableVec3;
    screenToWorld(point: Vec3Like, out?: MutableVec3): MutableVec3;

    /**
     * A snapshot of the whole scene, for a debugger, an inspector panel, or editor selection UI.
     *
     * DEV AND TOOLING ONLY. This is the one method here that ALLOCATES per call — a fresh object
     * per node — so it must not be called per frame in a shipped game, and no game logic may
     * branch on what it returns. The narrow queries exist for that: `resolvedTransformOf` for one
     * node's position, `worldBoundsOf` for one node's extent.
     *
     * It is on the interface rather than test-only — the shape `isCulled` and `drawOrderOf` take —
     * because enumeration is otherwise IMPOSSIBLE from outside: the per-node queries are all
     * top-down from a handle the caller already holds, so nothing can discover a surface's roots.
     * A tool that cannot enumerate cannot show a node its caller forgot to track, which is the
     * bug class an inspector is worth having for. Every backend answers it from `RendererCore`,
     * so the cost of the wider contract is a one-line delegation.
     *
     * Returns an empty snapshot before `init` and after `destroy`, never `null`.
     */
    inspect(opts?: InspectOptions): SceneSnapshot;

    /** Returns an unsubscribe function, matching api_spec.ts:264. */
    on<K extends keyof RendererEvents>(
        event: K,
        handler: (e: RendererEvents[K]) => void,
    ): () => void;

    /** No `dt` — the renderer owns no clock (§11.1). Nothing draws until this is called. */
    render(): void;
}

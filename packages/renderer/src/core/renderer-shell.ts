// The backend-independent half of an `IRenderer`: the members that are pure delegation to
// `RendererCore`, the "no core yet, or no longer" no-op rule, and the fonts-last unload policy.
//
// A backend extends this and supplies only what a display context makes different — `init`,
// `destroy`, `render`, its surface resize, its context state, the asset pipeline, residency and text
// measurement. The shared state is `protected` rather than `#`: a subclass cannot reach a private
// field, so the erasure is the price of holding these members in one copy.

import type { Bounds, MutableVec3, Size, Vec3Like } from '@platform/math';
import type {
    AssetInfo,
    AssetLoadResult,
    AssetManifestEntry,
    AssetUnloadResult,
    CameraState,
    ContextState,
    InspectOptions,
    IRenderer,
    NodeDesc,
    NodePatch,
    RendererEvents,
    RendererInitOptions,
    SceneSnapshot,
    SubtreeNodeDesc,
    Surface,
    TextStyle,
    Transform,
} from '../renderer.js';
import type { NodeId } from '../node-id.js';
import { NO_NODE } from '../node-id.js';
import { AssetQueue } from '../asset-queue.js';
import type { RendererCore } from './renderer-core.js';
import { emptySnapshot } from './renderer-core.js';

/** What both backends share of `IRenderer`. Extend it; do not construct it. */
export abstract class RendererShell implements IRenderer {
    /** The core, or `null` before `init` and after `destroy`. A backend's `init` installs it. */
    protected core: RendererCore | null = null;

    /** Set by a backend's `destroy`, so a late call no-ops instead of resurrecting the renderer. */
    protected destroyed = false;

    /** GPU asset work deferred past a context loss; a backend that cannot lose one never fills it. */
    protected readonly queue = new AssetQueue();

    get initialized(): boolean {
        return this.core !== null && !this.destroyed;
    }

    abstract get contextState(): ContextState;

    abstract get pendingAssetOps(): number;

    abstract init(options: RendererInitOptions): Promise<void>;

    abstract destroy(): void;

    abstract render(): void;

    resize(cssWidth: number, cssHeight: number): void {
        const core = this.live();
        if (core === null) return;
        core.setCanvasSize(cssWidth, cssHeight);
        this.resizeSurface(core.canvasSize.width, core.canvasSize.height, core.resolution);
        core.emit('resize', {
            canvas: { ...core.canvasSize },
            stage: { ...core.stageRect },
            viewport: { ...core.viewport },
            resolution: core.resolution,
        });
    }

    get canvasSize(): Readonly<Size> {
        return this.core?.canvasSize ?? { width: 0, height: 0 };
    }

    get resolution(): number {
        return this.core?.resolution ?? 1;
    }

    get stageRect(): Readonly<Bounds> {
        return this.core?.stageRect ?? { left: 0, right: 0, top: 0, bottom: 0 };
    }

    get viewport(): Bounds {
        return this.core?.viewport ?? { left: 0, right: 0, top: 0, bottom: 0 };
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.live()?.setSurfaceVisible(surface, visible);
    }

    isSurfaceEnabled(surface: Surface): boolean {
        return this.core?.isSurfaceEnabled(surface) ?? false;
    }

    abstract loadAsset(entry: AssetManifestEntry): Promise<AssetInfo>;

    abstract loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult>;

    abstract createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo>;

    abstract getAssetSize(name: string): Readonly<Size> | null;

    async unloadAssets(
        entries: readonly (string | AssetManifestEntry)[],
    ): Promise<AssetUnloadResult> {
        return Promise.resolve(this.unloadResident(assetNames(entries)));
    }

    hasAsset(name: string): boolean {
        // Intended state, post-queue, so a caller cannot branch wrongly mid-loss — routed this way
        // even for a backend that never queues, so both take the same path.
        return this.queue.intendedHas(name, this.isResident(name));
    }

    createNode(desc: NodeDesc): NodeId {
        return this.live()?.createNode(desc) ?? NO_NODE;
    }

    createNodes(descs: readonly NodeDesc[], out: NodeId[] = []): NodeId[] {
        return this.live()?.createNodes(descs, out) ?? ((out.length = 0), out);
    }

    createSubtree(descs: readonly SubtreeNodeDesc[], out: NodeId[] = []): NodeId[] {
        return this.live()?.createSubtree(descs, out) ?? ((out.length = 0), out);
    }

    async createNodeAsync(desc: NodeDesc): Promise<{ id: NodeId } & AssetInfo> {
        const id = this.createNode(desc);
        const name = desc.kind === 'sprite' ? desc.texture : '';
        const size =
            desc.kind === 'text'
                ? this.measureTextSize(desc.text, desc.style)
                : (this.getAssetSize(name) ?? this.fallbackAssetSize);
        return Promise.resolve({ id, name, size: { ...size } });
    }

    destroyNode(id: NodeId): void {
        this.live()?.destroyNode(id);
    }

    destroyNodes(ids: readonly NodeId[]): void {
        for (const id of ids) this.destroyNode(id);
    }

    updateNodes(patches: readonly NodePatch[]): void {
        this.live()?.updateNodes(patches);
    }

    updateSubtree(
        root: NodeId,
        patch: Omit<NodePatch, 'id' | 'parent'>,
        opts?: { includeRoot?: boolean },
    ): void {
        this.live()?.updateSubtree(root, patch, opts);
    }

    setNodeText(id: NodeId, text: string): void {
        this.live()?.setNodeText(id, text);
    }

    isAlive(id: NodeId): boolean {
        return this.core?.nodes.isAlive(id) ?? false;
    }

    clear(surface?: Surface): void {
        this.live()?.clear(surface);
    }

    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        this.live()?.attachNode(child, parent, opts);
    }

    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        this.live()?.detachNode(child, opts);
    }

    parentOf(id: NodeId): NodeId {
        return this.core?.parentOf(id) ?? NO_NODE;
    }

    childrenOf(id: NodeId, out: NodeId[] = []): NodeId[] {
        return this.core?.childrenOf(id, out) ?? ((out.length = 0), out);
    }

    surfaceOf(id: NodeId): Surface | null {
        return this.core?.surfaceOf(id) ?? null;
    }

    setCamera(camera: Readonly<CameraState>): void {
        // Touches one container and zero nodes.
        this.live()?.setCamera(camera);
    }

    get camera(): Readonly<CameraState> {
        return this.core?.camera ?? { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' };
    }

    localTransformOf(id: NodeId, out?: Transform): Transform | null {
        return this.core?.localTransformOf(id, out) ?? null;
    }

    resolvedTransformOf(id: NodeId, out?: Transform): Transform | null {
        return this.core?.resolvedTransformOf(id, out) ?? null;
    }

    localBoundsOf(id: NodeId): Bounds | null {
        return this.core?.localBoundsOf(id) ?? null;
    }

    worldBoundsOf(id: NodeId): Bounds | null {
        return this.core?.worldBoundsOf(id) ?? null;
    }

    screenBoundsOf(id: NodeId): Bounds | null {
        return this.core?.screenBoundsOf(id) ?? null;
    }

    screenPositionOf(id: NodeId, out?: MutableVec3): MutableVec3 | null {
        return this.core?.screenPositionOf(id, out) ?? null;
    }

    worldToScreen(point: Vec3Like, out?: MutableVec3): MutableVec3 {
        return this.core?.worldToScreen(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    screenToWorld(point: Vec3Like, out?: MutableVec3): MutableVec3 {
        return this.core?.screenToWorld(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    inspect(opts?: InspectOptions): SceneSnapshot {
        const core = this.core;
        if (core === null) return emptySnapshot(this.contextState);
        return core.inspect(opts, this.residentAssets(), this.contextState);
    }

    on<K extends keyof RendererEvents>(
        event: K,
        handler: (e: RendererEvents[K]) => void,
    ): () => void {
        return this.core?.on(event, handler) ?? (() => undefined);
    }

    /** `true` when `render()` culled this node. Test-only: a caller must not branch on it. */
    isCulled(id: NodeId): boolean {
        return this.core?.isCulled(id) ?? false;
    }

    /** The core, or `null` before init and after destroy, which makes every method a no-op. */
    protected live(): RendererCore | null {
        return this.destroyed ? null : this.core;
    }

    /**
     * Drops the core and any deferred asset work; a backend's `destroy` calls this once.
     *
     * A backend's own fields go around it, since only the backend knows what must be released
     * before the core lets go of the scene and what must outlive it.
     */
    protected teardownCore(): void {
        this.core?.teardown();
        this.core = null;
        this.queue.clear();
    }

    /**
     * Unloads `names`, reporting rather than throwing.
     *
     * Fonts last: one still referenced by live text is kept, because dropping it re-rasterizes that
     * text to a fallback face, which reads as corruption.
     */
    protected unloadResident(names: readonly string[]): AssetUnloadResult {
        const result: AssetUnloadResult = { unloaded: [], unknown: [], inUse: [], queued: false };

        const fonts: string[] = [];
        const rest: string[] = [];
        for (const name of names) {
            (this.kindOf(name) === 'font' ? fonts : rest).push(name);
        }

        for (const name of [...rest, ...fonts]) {
            if (!this.reportUnload(name, result)) continue;
            this.dropResident(name);
            result.unloaded.push(name);
        }

        return result;
    }

    /**
     * Records `name` as unknown or in use, and answers whether it should unload.
     *
     * Reporting is separated from the drop because a backend that only *intends* an unload has to
     * report the same three ways from the same residency.
     */
    protected reportUnload(name: string, result: AssetUnloadResult): boolean {
        if (!this.isResident(name)) {
            // Reported, not thrown: idempotent teardown needs no guard.
            result.unknown.push(name);
            return false;
        }

        const nodeCount = this.referenceCount(name);
        if (nodeCount > 0) {
            result.inUse.push({ name, nodeCount });
            // A font in use is kept; anything else unloads and shows the placeholder.
            if (this.kindOf(name) === 'font') return false;
        }

        return true;
    }

    /** Resizes the backend's drawing surface, at the canvas size the core settled on. */
    protected abstract resizeSurface(width: number, height: number, resolution: number): void;

    /** The size reported for a texture name that is not resident. */
    protected abstract get fallbackAssetSize(): Readonly<Size>;

    /** Measures a string without touching the GPU, so it answers during a context loss too. */
    protected abstract measureTextSize(text: string, style: TextStyle | undefined): Size;

    /** Resident names with copied sizes — the one input to `inspect` a backend owns. */
    protected abstract residentAssets(): Array<{ name: string; size: Size }>;

    protected abstract isResident(name: string): boolean;

    /** The kind a resident name was loaded as, or `null` when it is not resident. */
    protected abstract kindOf(name: string): AssetManifestEntry['kind'] | null;

    /** Live nodes referencing a name — the `inUse` count. */
    protected abstract referenceCount(name: string): number;

    /** Drops one resident name, along with whatever the backend pointed at it. */
    protected abstract dropResident(name: string): void;
}

/** The names an unload was asked for, which may arrive as entries. */
export function assetNames(entries: readonly (string | AssetManifestEntry)[]): string[] {
    return entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

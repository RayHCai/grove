// A complete `IRenderer` with no DOM and no GPU, not a stub: everything backend-independent comes
// from `RendererCore`, the same class the Pixi backend uses, so the contract suite exercises the
// real code paths.
//
// What differs lives in `NullSink`: there are no display objects, and sizes come from the manifest
// or a deterministic formula because a headless backend can neither decode a PNG nor measure a
// font.

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
    Surface,
    TextStyle,
    Transform,
} from '../renderer.js';
import type { NodeId } from '../node-id.js';
import { NO_NODE } from '../node-id.js';
import { rendererError } from '../errors.js';
import { surfaceOrder } from '../surfaces.js';
import type { NodeRecord } from '../node-store.js';
import { AssetQueue, validateAssetEntry } from '../asset-queue.js';
import type { SceneSink } from '../core/scene-sink.js';
import { emptySnapshot, RendererCore, resolveInitOptions } from '../core/renderer-core.js';
import { effectiveResolution } from '../viewport.js';

/** What a headless backend reports for an image whose manifest declares no `size`. */
const UNKNOWN_IMAGE_SIZE: Size = { width: 1, height: 1 };

/** Default text size when a style omits it. */
const DEFAULT_TEXT_SIZE = 16;

/** Per-character advance as a fraction of the font size. See {@link measureTextHeadless}. */
const HEADLESS_CHAR_ADVANCE = 0.5;

/**
 * Deterministic stand-in for text measurement.
 *
 * Not a real font's metrics and not meant to be: stable across runs and monotonic in the text
 * length and the style size is all a test can legitimately depend on.
 */
export function measureTextHeadless(text: string, style: TextStyle | undefined): Size {
    const size = style?.size ?? DEFAULT_TEXT_SIZE;
    const lines = text.split('\n');
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const lineHeight = style?.lineHeight ?? size * 1.2;
    return {
        width: longest * size * HEADLESS_CHAR_ADVANCE,
        height: Math.max(1, lines.length) * lineHeight,
    };
}

/** A resident asset: the size reported plus the manifest entry retained for a restore. */
interface ResidentAsset {
    size: Size;
    entry: AssetManifestEntry;
}

/** No display objects, so every method but `sizeOf` and the visibility pair is empty. */
class NullSink implements SceneSink {
    readonly #visible = new Map<Surface, boolean>();
    readonly #assets: Map<string, ResidentAsset>;

    constructor(assets: Map<string, ResidentAsset>, enabled: readonly Surface[]) {
        this.#assets = assets;
        for (const surface of enabled) this.#visible.set(surface, true);
    }

    create(): void {}
    reparent(): void {}
    destroySubtree(): void {}
    write(): void {}
    setRenderable(): void {}
    setTexture(): void {}
    setText(): void {}
    setLayer(): void {}
    applyView(): void {}
    clearAll(): void {}

    sizeOf(_index: number, record: NodeRecord): Size {
        if (record.kind === 'text') return measureTextHeadless(record.text, record.style);
        return this.#assets.get(record.texture)?.size ?? UNKNOWN_IMAGE_SIZE;
    }

    surfaceVisible(surface: Surface): boolean {
        return this.#visible.get(surface) ?? false;
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.#visible.set(surface, visible);
    }
}

/**
 * A headless `IRenderer`.
 *
 * Also exposes `isCulled` and `drawOrderOf`, which are not on `IRenderer`: the contract suite needs
 * a backend-independent way to ask about cull state and draw order.
 */
export class NullRenderer implements IRenderer {
    #core: RendererCore | null = null;
    #sink: NullSink | null = null;
    #destroyed = false;

    readonly #queue = new AssetQueue();
    readonly #assets = new Map<string, ResidentAsset>();

    get initialized(): boolean {
        return this.#core !== null && !this.#destroyed;
    }

    /** Always `'ok'`: there is no GPU context to lose, so nothing ever queues. */
    get contextState(): ContextState {
        return 'ok';
    }

    /** Always 0, for the same reason. */
    get pendingAssetOps(): number {
        return 0;
    }

    // `async` so an option violation rejects rather than throwing synchronously, which a caller
    // writing `init(...).catch(...)` would miss.
    async init(options: RendererInitOptions): Promise<void> {
        if (this.#core !== null) {
            rendererError('already-initialized', 'init() was already called on this renderer');
        }

        // No container to measure, so the design stage is the initial canvas size.
        const canvas = { width: options.design.width, height: options.design.height };
        // No `devicePixelRatio` either: a headless backend has no display.
        const resolution = effectiveResolution(1, options.maxResolution ?? 2);
        const config = resolveInitOptions(options, canvas, resolution);

        this.#sink = new NullSink(this.#assets, config.enabledSurfaces);
        this.#core = new RendererCore(this.#sink, config);
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.#destroyed = true;
        this.#core?.teardown();
        this.#core = null;
        this.#sink = null;
        this.#queue.clear();
        this.#assets.clear();
    }

    resize(cssWidth: number, cssHeight: number): void {
        const core = this.#live();
        if (core === null) return;
        core.setCanvasSize(cssWidth, cssHeight);
        core.emit('resize', {
            canvas: { ...core.canvasSize },
            stage: { ...core.stageRect },
            viewport: { ...core.viewport },
            resolution: core.resolution,
        });
    }

    get canvasSize(): Readonly<Size> {
        return this.#core?.canvasSize ?? { width: 0, height: 0 };
    }

    get resolution(): number {
        return this.#core?.resolution ?? 1;
    }

    get stageRect(): Readonly<Bounds> {
        return this.#core?.stageRect ?? { left: 0, right: 0, top: 0, bottom: 0 };
    }

    get viewport(): Bounds {
        return this.#core?.viewport ?? { left: 0, right: 0, top: 0, bottom: 0 };
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.#live()?.setSurfaceVisible(surface, visible);
    }

    isSurfaceEnabled(surface: Surface): boolean {
        return this.#core?.isSurfaceEnabled(surface) ?? false;
    }

    async loadAsset(entry: AssetManifestEntry): Promise<AssetInfo> {
        return Promise.resolve(this.#loadOne(entry));
    }

    async loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        const result: AssetLoadResult = { loaded: [], failed: [], queued: false };
        for (const entry of entries) {
            // Resolves with a result rather than rejecting, so one bad entry cannot kill a
            // whole level load.
            try {
                result.loaded.push(this.#loadOne(entry));
            } catch (error) {
                result.failed.push({
                    name: entry.name,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return Promise.resolve(result);
    }

    async unloadAssets(
        entries: readonly (string | AssetManifestEntry)[],
    ): Promise<AssetUnloadResult> {
        const result: AssetUnloadResult = { unloaded: [], unknown: [], inUse: [], queued: false };
        const core = this.#core;

        // Fonts last: one still referenced by live text is kept, because dropping it re-rasterizes
        // that text to a fallback face, which reads as corruption.
        const names = entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
        const fonts: string[] = [];
        const rest: string[] = [];
        for (const name of names) {
            (this.#assets.get(name)?.entry.kind === 'font' ? fonts : rest).push(name);
        }

        for (const name of [...rest, ...fonts]) {
            const resident = this.#assets.get(name);
            if (resident === undefined) {
                // Reported, not thrown: idempotent teardown needs no guard.
                result.unknown.push(name);
                continue;
            }

            const nodeCount = core?.referenceCount(name) ?? 0;
            if (nodeCount > 0) {
                result.inUse.push({ name, nodeCount });
                // A font in use is kept; anything else unloads and shows the placeholder.
                if (resident.entry.kind === 'font') continue;
            }

            this.#assets.delete(name);
            result.unloaded.push(name);
        }

        return Promise.resolve(result);
    }

    async createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo> {
        const entry: AssetManifestEntry = {
            name,
            kind: 'text',
            text,
            ...(style !== undefined && { style }),
        };
        return Promise.resolve(this.#loadOne(entry));
    }

    hasAsset(name: string): boolean {
        // Routed through the queue even though nothing queues here, so both backends take the
        // same intended-state path.
        return this.#queue.intendedHas(name, this.#assets.has(name));
    }

    getAssetSize(name: string): Readonly<Size> | null {
        return this.#assets.get(name)?.size ?? null;
    }

    createNode(desc: NodeDesc): NodeId {
        return this.#live()?.createNode(desc) ?? NO_NODE;
    }

    createNodes(descs: readonly NodeDesc[], out: NodeId[] = []): NodeId[] {
        return this.#live()?.createNodes(descs, out) ?? ((out.length = 0), out);
    }

    async createNodeAsync(desc: NodeDesc): Promise<{ id: NodeId } & AssetInfo> {
        const id = this.createNode(desc);
        const name = desc.kind === 'sprite' ? desc.texture : '';
        const size =
            desc.kind === 'text'
                ? measureTextHeadless(desc.text, desc.style)
                : (this.getAssetSize(name) ?? UNKNOWN_IMAGE_SIZE);
        return Promise.resolve({ id, name, size: { ...size } });
    }

    destroyNode(id: NodeId): void {
        this.#live()?.destroyNode(id);
    }

    destroyNodes(ids: readonly NodeId[]): void {
        for (const id of ids) this.destroyNode(id);
    }

    updateNodes(patches: readonly NodePatch[]): void {
        this.#live()?.updateNodes(patches);
    }

    updateSubtree(
        root: NodeId,
        patch: Omit<NodePatch, 'id' | 'parent'>,
        opts?: { includeRoot?: boolean },
    ): void {
        this.#live()?.updateSubtree(root, patch, opts);
    }

    setNodeText(id: NodeId, text: string): void {
        this.#live()?.setNodeText(id, text);
    }

    isAlive(id: NodeId): boolean {
        return this.#core?.nodes.isAlive(id) ?? false;
    }

    clear(surface?: Surface): void {
        this.#live()?.clear(surface);
    }

    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        this.#live()?.attachNode(child, parent, opts);
    }

    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        this.#live()?.detachNode(child, opts);
    }

    parentOf(id: NodeId): NodeId {
        return this.#core?.parentOf(id) ?? NO_NODE;
    }

    childrenOf(id: NodeId, out: NodeId[] = []): NodeId[] {
        return this.#core?.childrenOf(id, out) ?? ((out.length = 0), out);
    }

    surfaceOf(id: NodeId): Surface | null {
        return this.#core?.surfaceOf(id) ?? null;
    }

    setCamera(camera: Readonly<CameraState>): void {
        this.#live()?.setCamera(camera);
    }

    get camera(): Readonly<CameraState> {
        return this.#core?.camera ?? { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' };
    }

    localTransformOf(id: NodeId, out?: Transform): Transform | null {
        return this.#core?.localTransformOf(id, out) ?? null;
    }

    resolvedTransformOf(id: NodeId, out?: Transform): Transform | null {
        return this.#core?.resolvedTransformOf(id, out) ?? null;
    }

    localBoundsOf(id: NodeId): Bounds | null {
        return this.#core?.localBoundsOf(id) ?? null;
    }

    worldBoundsOf(id: NodeId): Bounds | null {
        return this.#core?.worldBoundsOf(id) ?? null;
    }

    screenBoundsOf(id: NodeId): Bounds | null {
        return this.#core?.screenBoundsOf(id) ?? null;
    }

    screenPositionOf(id: NodeId, out?: MutableVec3): MutableVec3 | null {
        return this.#core?.screenPositionOf(id, out) ?? null;
    }

    worldToScreen(point: Vec3Like, out?: MutableVec3): MutableVec3 {
        return this.#core?.worldToScreen(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    screenToWorld(point: Vec3Like, out?: MutableVec3): MutableVec3 {
        return this.#core?.screenToWorld(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    inspect(opts?: InspectOptions): SceneSnapshot {
        const core = this.#core;
        if (core === null) return emptySnapshot(this.contextState);
        const assets = [...this.#assets].map(([name, asset]) => ({
            name,
            size: { ...asset.size },
        }));
        return core.inspect(opts, assets, this.contextState);
    }

    on<K extends keyof RendererEvents>(
        event: K,
        handler: (e: RendererEvents[K]) => void,
    ): () => void {
        return this.#core?.on(event, handler) ?? (() => undefined);
    }

    render(): void {
        // Resolves and culls for real; there is simply nothing to present afterwards.
        this.#live()?.flush();
    }

    /** `true` when `render()` culled this node. Test-only: a caller must not branch on it. */
    isCulled(id: NodeId): boolean {
        return this.#core?.isCulled(id) ?? false;
    }

    /** Root ids for a surface in draw order. Test-only, for the same reason as {@link isCulled}. */
    drawOrderOf(surface: Surface): NodeId[] {
        return this.#core?.drawOrderOf(surface) ?? [];
    }

    /** Draw order of the surfaces themselves. Test-only. */
    surfaceDrawOrder(): Surface[] {
        const enabled = this.#core?.config.enabledSurfaces ?? [];
        return [...enabled].toSorted((a, b) => surfaceOrder(a) - surfaceOrder(b));
    }

    /** The core, or `null` before init and after destroy, which makes every method a no-op. */
    #live(): RendererCore | null {
        return this.#destroyed ? null : this.#core;
    }

    #loadOne(entry: AssetManifestEntry): AssetInfo {
        // The same validator the Pixi backend uses: a manifest one backend accepts and the other
        // rejects is a divergence the contract suite cannot see.
        validateAssetEntry(entry);
        const size = this.#sizeOf(entry);
        // The entry is retained because a restore re-uploads from it and `unloadAssets` accepts
        // entries as well as names.
        this.#assets.set(entry.name, { size, entry });
        return { name: entry.name, size: { ...size } };
    }

    #sizeOf(entry: AssetManifestEntry): Size {
        switch (entry.kind) {
            case 'text':
                return measureTextHeadless(entry.text, entry.style);
            case 'image':
                // A headless backend cannot decode a PNG, so a declared size is the only real
                // answer; the 1x1 fallback keeps `AssetInfo` uniform rather than returning null.
                return entry.size ?? UNKNOWN_IMAGE_SIZE;
            case 'atlas':
            case 'font':
                return UNKNOWN_IMAGE_SIZE;
        }
    }
}

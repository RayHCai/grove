// The PixiJS backend. ORCHESTRATION ONLY.
//
// This file holds no arithmetic and no store logic. The backend-independent half lives in
// `core/renderer-core.ts` — the SAME instance type the headless backend uses — and the display
// objects live behind `PixiSink`. What is left here is genuinely Pixi's: `Application` setup, the
// DPR read, the ResizeObserver, the asset pipeline, the context guard, and presenting a frame.
//
// Sharing the core is what keeps the two backends honest. Before it existed, 15 methods here were
// byte-identical to their headless twins and `createNode`'s whole validation block was duplicated,
// with only one backend under test — and they had already drifted on the cull path.

import { Application } from 'pixi.js';
import type { Bounds, Size, Vec3, Vec3Like } from '@platform/math';
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
import { AssetQueue } from '../asset-queue.js';
import type { MergedAssetWork } from '../asset-queue.js';
import { emptySnapshot, RendererCore, resolveInitOptions } from '../core/renderer-core.js';
import { effectiveResolution } from '../viewport.js';
import { AssetRegistry } from './asset-registry.js';
import { measureText, rasterizeText } from './text-raster.js';
import { SurfaceTree } from './surface-tree.js';
import { PixiSink } from './pixi-sink.js';
import { CANCELLED_REASON, ContextGuard } from './context-guard.js';

/** Fallback size for a texture that is not resident. */
const PLACEHOLDER_SIZE: Size = { width: 1, height: 1 };

/** The PixiJS v8 implementation of {@link IRenderer}. */
export class PixiRenderer implements IRenderer {
    #app: Application | null = null;
    #core: RendererCore | null = null;
    #sink: PixiSink | null = null;
    #surfaces: SurfaceTree | null = null;
    #guard: ContextGuard | null = null;
    #observer: ResizeObserver | null = null;
    #destroyed = false;

    readonly #queue = new AssetQueue();
    readonly #assets = new AssetRegistry();

    get initialized(): boolean {
        return this.#core !== null && !this.#destroyed;
    }

    get contextState(): ContextState {
        return this.#guard?.state ?? 'ok';
    }

    get pendingAssetOps(): number {
        return this.#guard?.pendingCount ?? 0;
    }

    // `async` so an option violation REJECTS rather than throwing synchronously — the same
    // contract the headless backend honours, and the reason `init` returns a promise at all is
    // that `Application.init()` is async (§14.4).
    async init(options: RendererInitOptions): Promise<void> {
        if (this.#core !== null) {
            rendererError('already-initialized', 'init() was already called on this renderer');
        }

        // This is the one module allowed to read a global — the pure helper takes the DPR as an
        // argument precisely so it stays testable.
        const dpr =
            typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
        const resolution = effectiveResolution(dpr, options.maxResolution ?? 2);

        const measured = measureContainer(options.container, options.design);
        // Validates and applies defaults BEFORE any GPU work, so a bad option cannot leave a
        // half-built Application behind.
        const config = resolveInitOptions(options, measured, resolution);

        this.#assets.setDefaultFilter(options.defaultFilter ?? 'nearest');

        const app = new Application();
        // Conditional spread throughout: `exactOptionalPropertyTypes` makes an explicit
        // `undefined` a compile error here.
        await app.init({
            width: measured.width,
            height: measured.height,
            resolution,
            antialias: options.antialias ?? false,
            preference: options.preference ?? 'webgl',
            // The client owns the frame loop, so Pixi's ticker must not drive rendering (§1).
            autoStart: false,
            autoDensity: true,
            ...(options.background === 'transparent'
                ? { backgroundAlpha: 0 }
                : options.background !== undefined
                  ? { background: options.background }
                  : {}),
        });
        this.#app = app;
        options.container.appendChild(app.canvas);

        this.#surfaces = new SurfaceTree(app.stage, config.enabledSurfaces);
        // The core and the sink each need the other, so the sink is constructed first and handed
        // the core's store immediately afterwards. The core calls no sink method while
        // constructing, so nothing observes the unbound window.
        const sink = new PixiSink(this.#surfaces, this.#assets);
        const core = new RendererCore(sink, config);
        sink.bind(core.xf);
        this.#sink = sink;
        this.#core = core;
        this.#installGuard(app);

        if (options.autoResize !== false) this.#installObserver(options.container);
        core.applyView();
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.#destroyed = true;

        this.#observer?.disconnect();
        this.#observer = null;
        // Settles queued promises as cancelled rather than rejecting, so teardown produces no
        // unhandled rejections (§10).
        this.#guard?.destroy(() => ({
            loaded: [],
            failed: [{ name: '*', reason: CANCELLED_REASON }],
            queued: false,
        }));
        this.#guard = null;

        this.#core?.teardown();
        this.#core = null;
        this.#sink = null;
        this.#surfaces?.destroy();
        this.#surfaces = null;
        this.#queue.clear();
        this.#assets.clear();

        // `removeView: true` takes the canvas out of the container, so a re-init on the same
        // element does not stack a second canvas on the first.
        this.#app?.destroy({ removeView: true }, { children: true });
        this.#app = null;
    }

    // ─── sizing ─────────────────────────────────────────────────────

    resize(cssWidth: number, cssHeight: number): void {
        const core = this.#live();
        if (core === null) return;
        core.setCanvasSize(cssWidth, cssHeight);
        this.#app?.renderer.resize(core.canvasSize.width, core.canvasSize.height, core.resolution);
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

    // ─── surfaces ───────────────────────────────────────────────────

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.#live()?.setSurfaceVisible(surface, visible);
    }

    isSurfaceEnabled(surface: Surface): boolean {
        return this.#core?.isSurfaceEnabled(surface) ?? false;
    }

    // ─── assets ─────────────────────────────────────────────────────

    async loadAsset(entry: AssetManifestEntry): Promise<AssetInfo> {
        const result = await this.loadAssets([entry]);
        const info = result.loaded[0];
        if (info === undefined) {
            throw new Error(result.failed[0]?.reason ?? `failed to load '${entry.name}'`);
        }
        return info;
    }

    async loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        if (this.#live() === null) return { loaded: [], failed: [], queued: false };

        // Mid-loss the intent is recorded and the work deferred; the promise still resolves, so
        // the caller's frame loop needs no branch (§10).
        const guard = this.#guard;
        if (guard?.lost === true) {
            for (const entry of entries) this.#queue.load(entry);
            return guard.run(async () => this.#loadNow(entries));
        }
        return this.#loadNow(entries);
    }

    async unloadAssets(
        entries: readonly (string | AssetManifestEntry)[],
    ): Promise<AssetUnloadResult> {
        if (this.#live() === null) {
            return { unloaded: [], unknown: [], inUse: [], queued: false };
        }

        const names = entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
        const guard = this.#guard;
        if (guard?.lost === true) {
            for (const name of names) this.#queue.unload(name);
            return guard.run(async () => this.#unloadNow(names));
        }
        return this.#unloadNow(names);
    }

    async createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo> {
        if (this.#live() === null) return { name, size: { width: 0, height: 0 } };

        const entry: AssetManifestEntry = {
            name,
            kind: 'text',
            text,
            ...(style !== undefined && { style }),
        };

        // Measurement uses a 2D canvas, so a real size is available even mid-loss — only the
        // upload queues, and layout never blocks (§9.3).
        const size = measureText(text, style);

        const upload = async (): Promise<AssetInfo> => {
            const app = this.#app;
            if (app === null) return { name, size: { ...size } };
            const raster = rasterizeText(app.renderer, text, style);
            return this.#assets.registerTexture(entry, raster.texture, raster.size);
        };

        const guard = this.#guard;
        if (guard?.lost === true) {
            this.#queue.load(entry);
            // Resolves with the MEASURED size now; the texture lands on restore.
            void guard.run(upload);
            return { name, size: { ...size } };
        }
        return upload();
    }

    hasAsset(name: string): boolean {
        // INTENDED state, post-queue — never raw GPU state, so a caller cannot branch wrongly
        // mid-loss (§10).
        return this.#queue.intendedHas(name, this.#assets.has(name));
    }

    getAssetSize(name: string): Readonly<Size> | null {
        return this.#assets.sizeOf(name);
    }

    // ─── nodes ──────────────────────────────────────────────────────

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
                ? measureText(desc.text, desc.style)
                : (this.getAssetSize(name) ?? PLACEHOLDER_SIZE);
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

    // ─── hierarchy ──────────────────────────────────────────────────

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

    // ─── camera ─────────────────────────────────────────────────────

    setCamera(camera: Readonly<CameraState>): void {
        // Touches one container and zero nodes (§6.4).
        this.#live()?.setCamera(camera);
    }

    get camera(): Readonly<CameraState> {
        return this.#core?.camera ?? { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' };
    }

    // ─── transforms & bounds ────────────────────────────────────────

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

    screenPositionOf(id: NodeId, out?: Vec3): Vec3 | null {
        return this.#core?.screenPositionOf(id, out) ?? null;
    }

    worldToScreen(point: Vec3Like, out?: Vec3): Vec3 {
        return this.#core?.worldToScreen(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    screenToWorld(point: Vec3Like, out?: Vec3): Vec3 {
        return this.#core?.screenToWorld(point, out) ?? { x: 0, y: 0, z: 0 };
    }

    inspect(opts?: InspectOptions): SceneSnapshot {
        const core = this.#core;
        if (core === null) return emptySnapshot(this.contextState);
        // The registry is ours, not the core's — asset residency is the one thing a backend owns
        // (§9), which is why the core takes the list rather than reading a map.
        return core.inspect(opts, this.#assets.inspectEntries(), this.contextState);
    }

    on<K extends keyof RendererEvents>(
        event: K,
        handler: (e: RendererEvents[K]) => void,
    ): () => void {
        return this.#core?.on(event, handler) ?? (() => undefined);
    }

    render(): void {
        const core = this.#live();
        if (core === null) return;
        // A no-op while the context is gone; the store stayed current, so the next good frame is
        // correct with no caller involvement (§10).
        if (this.#guard?.lost === true) return;

        core.flush();
        this.#app?.render();
    }

    /** `true` when `render()` culled this node. Test-only, mirroring the headless backend. */
    isCulled(id: NodeId): boolean {
        return this.#core?.isCulled(id) ?? false;
    }

    // ─── internals ──────────────────────────────────────────────────

    /** The core, or `null` before init and after destroy — which makes every method a no-op. */
    #live(): RendererCore | null {
        return this.#destroyed ? null : this.#core;
    }

    #installObserver(container: HTMLElement): void {
        if (typeof ResizeObserver === 'undefined') return;
        this.#observer = new ResizeObserver(() => {
            const core = this.#core;
            if (core === null) return;
            const size = measureContainer(container, core.config.design);
            this.resize(size.width, size.height);
        });
        this.#observer.observe(container);
    }

    #installGuard(app: Application): void {
        // WebGPU exposes device loss as a promise rather than a DOM event; feature-detected
        // because a WebGL renderer has no `.gpu` (§10).
        const gpu = (app.renderer as { gpu?: { device?: { lost?: Promise<unknown> } } }).gpu;
        const deviceLost = gpu?.device?.lost;

        this.#guard = new ContextGuard(this.#queue, {
            retainedManifest: () => this.#assets.retainedManifest(),
            reupload: async (work) => this.#reupload(work),
            rebuildScene: () => this.#core?.rebuildScene(),
            onLost: (reason) => this.#core?.emit('contextlost', { reason }),
            onRestored: (reloadedAssets, failedAssets) =>
                this.#core?.emit('contextrestored', { reloadedAssets, failedAssets }),
        });
        this.#guard.install(
            app.canvas as HTMLCanvasElement,
            ...(deviceLost !== undefined ? ([deviceLost] as const) : ([] as const)),
        );
    }

    async #reupload(work: MergedAssetWork): Promise<{ reloaded: string[]; failed: string[] }> {
        const reloaded: string[] = [];
        const failed: string[] = [];

        for (const name of work.toUnload) this.#assets.unload(name);
        for (const entry of work.toLoad) {
            const outcome = await this.#assets.load(entry);
            if (outcome.info !== undefined) reloaded.push(outcome.info.name);
            else if (outcome.failure !== undefined) failed.push(outcome.failure.name);
        }
        return { reloaded, failed };
    }

    /**
     * Loads entries SEQUENTIALLY, on purpose.
     *
     * `Promise.all` would be faster but would make two things nondeterministic: the order of
     * `loaded`/`failed`, and which atlas wins a cross-sheet frame-name collision. A level load
     * that reports its failures in a different order every run costs far more to debug than the
     * parallelism is worth.
     */
    async #loadNow(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        const result: AssetLoadResult = { loaded: [], failed: [], queued: false };
        for (const entry of entries) {
            if (entry.kind === 'text') {
                // A text entry rasterizes rather than fetches (§9.3).
                result.loaded.push(await this.createTextAsset(entry.name, entry.text, entry.style));
                continue;
            }
            const outcome = await this.#assets.load(entry);
            if (outcome.info !== undefined) result.loaded.push(outcome.info);
            if (outcome.failure !== undefined) result.failed.push(outcome.failure);
        }
        return result;
    }

    async #unloadNow(names: readonly string[]): Promise<AssetUnloadResult> {
        const result: AssetUnloadResult = { unloaded: [], unknown: [], inUse: [], queued: false };
        const core = this.#core;

        // Fonts LAST: one still referenced by a live text node is kept, because dropping it
        // re-rasterizes live text to a fallback face, which reads as corruption (§9.2).
        const fonts: string[] = [];
        const rest: string[] = [];
        for (const name of names) {
            (this.#assets.kindOf(name) === 'font' ? fonts : rest).push(name);
        }

        for (const name of [...rest, ...fonts]) {
            if (!this.#assets.has(name)) {
                result.unknown.push(name);
                continue;
            }

            const nodeCount = core?.referenceCount(name) ?? 0;
            const isFont = this.#assets.kindOf(name) === 'font';
            if (nodeCount > 0) {
                result.inUse.push({ name, nodeCount });
                if (isFont) continue;
            }

            // Affected nodes fall back to the placeholder; their ids stay valid (§9.2).
            const slots = core?.slotsUsingTexture(name) ?? [];
            this.#assets.unload(name);
            this.#sink?.repointToPlaceholder(slots);
            result.unloaded.push(name);
        }

        return result;
    }
}

/**
 * The container's CSS size, falling back to the design stage.
 *
 * A container measured mid-layout reports 0; the design stage is the sane starting point and the
 * ResizeObserver corrects it on the first real layout.
 */
function measureContainer(container: HTMLElement, design: Size): Size {
    const width = container.clientWidth;
    const height = container.clientHeight;
    return {
        width: width > 0 ? width : design.width,
        height: height > 0 ? height : design.height,
    };
}

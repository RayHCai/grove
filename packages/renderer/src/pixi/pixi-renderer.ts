// Orchestration only: no arithmetic and no store logic. What is left here is genuinely Pixi's —
// `Application` setup, the DPR read, the ResizeObserver, the asset pipeline, the context guard and
// presenting a frame — while the shared half lives in `RendererShell` plus `RendererCore`, and
// the display objects behind `PixiSink`.

import { Application } from 'pixi.js';
import type { Size } from '@platform/math';
import type {
    AssetInfo,
    AssetLoadResult,
    AssetManifestEntry,
    AssetUnloadResult,
    ContextState,
    RendererInitOptions,
    TextStyle,
} from '../renderer.js';
import { rendererError } from '../errors.js';
import { validateAssetEntry } from '../asset-queue.js';
import type { MergedAssetWork } from '../asset-queue.js';
import { RendererCore, resolveInitOptions } from '../core/renderer-core.js';
import { assetNames, RendererShell } from '../core/renderer-shell.js';
import { effectiveResolution } from '../viewport.js';
import { AssetRegistry } from './asset-registry.js';
import { measureText, rasterizeText } from './text-raster.js';
import { SurfaceTree } from './surface-tree.js';
import { PixiSink } from './pixi-sink.js';
import { CANCELLED_REASON, ContextGuard } from './context-guard.js';

/** Fallback size for a texture that is not resident. */
const PLACEHOLDER_SIZE: Size = { width: 1, height: 1 };

/** The PixiJS v8 implementation of {@link IRenderer}. */
export class PixiRenderer extends RendererShell {
    #app: Application | null = null;
    #sink: PixiSink | null = null;
    #surfaces: SurfaceTree | null = null;
    #guard: ContextGuard | null = null;
    #observer: ResizeObserver | null = null;

    readonly #assets = new AssetRegistry();

    get contextState(): ContextState {
        return this.#guard?.state ?? 'ok';
    }

    get pendingAssetOps(): number {
        return this.#guard?.pendingCount ?? 0;
    }

    // `async` so an option violation rejects rather than throwing synchronously, matching the
    // headless backend; `init` returns a promise at all because `Application.init()` is async.
    async init(options: RendererInitOptions): Promise<void> {
        if (this.core !== null) {
            rendererError('already-initialized', 'init() was already called on this renderer');
        }

        // The one module allowed to read a global; the pure helper takes the DPR as an argument.
        const dpr =
            typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
        const resolution = effectiveResolution(dpr, options.maxResolution ?? 2);

        const measured = measureContainer(options.container, options.design);
        // Before any GPU work, so a bad option cannot leave a half-built Application behind.
        const config = resolveInitOptions(options, measured, resolution);

        this.#assets.setDefaultFilter(options.defaultFilter ?? 'nearest');

        const app = new Application();
        // Conditional spread because `exactOptionalPropertyTypes` makes an explicit `undefined` a
        // compile error.
        await app.init({
            width: measured.width,
            height: measured.height,
            resolution,
            antialias: options.antialias ?? false,
            preference: options.preference ?? 'webgl',
            // The client owns the frame loop, so Pixi's ticker must not drive rendering.
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
        // Each needs the other, so the sink is built first and bound immediately afterwards; the
        // core calls no sink method while constructing, so nothing observes the unbound window.
        const sink = new PixiSink(this.#surfaces, this.#assets);
        const core = new RendererCore(sink, config);
        sink.bind(core.xf);
        this.#sink = sink;
        this.core = core;
        this.#installGuard(app);

        if (options.autoResize !== false) this.#installObserver(options.container);
        core.applyView();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.#observer?.disconnect();
        this.#observer = null;
        // Settles queued promises as cancelled rather than rejecting, so teardown stays quiet.
        this.#guard?.destroy();
        this.#guard = null;

        this.teardownCore();
        this.#sink = null;
        this.#surfaces?.destroy();
        this.#surfaces = null;
        this.#assets.clear();

        // `removeView: true`, so a re-init on the same element cannot stack a second canvas.
        this.#app?.destroy({ removeView: true }, { children: true });
        this.#app = null;
    }

    render(): void {
        const core = this.live();
        if (core === null) return;
        // A no-op while the context is gone: the store stayed current, so the next good frame is
        // correct with no caller involvement.
        if (this.#guard?.lost === true) return;

        core.flush();
        this.#app?.render();
    }

    async loadAsset(entry: AssetManifestEntry): Promise<AssetInfo> {
        const result = await this.loadAssets([entry]);
        const info = result.loaded[0];
        if (info === undefined) {
            throw new Error(result.failed[0]?.reason ?? `failed to load '${entry.name}'`);
        }
        return info;
    }

    async loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        if (this.live() === null) return { loaded: [], failed: [], queued: false };

        const guard = this.#guard;
        if (guard?.lost === true) {
            // Mid-loss the intent is recorded and the restore's merge performs the upload, so the
            // deferred operation only reports what landed — replaying the load here would upload
            // every entry a second time.
            const names = entries.map((entry) => entry.name);
            for (const entry of entries) this.queue.load(entry);
            return guard.run(
                async () => this.#loadResultFor(names),
                () => cancelledLoad(names),
            );
        }
        return this.#loadNow(entries);
    }

    override async unloadAssets(
        entries: readonly (string | AssetManifestEntry)[],
    ): Promise<AssetUnloadResult> {
        if (this.live() === null) {
            return { unloaded: [], unknown: [], inUse: [], queued: false };
        }

        const names = assetNames(entries);
        const guard = this.#guard;
        if (guard?.lost === true) {
            // Reported from current residency and resolved now: the restore's merge performs the
            // drop, and a deferred replay would run after it and report every name as unknown.
            const result = this.#unloadIntent(names);
            for (const name of names) this.queue.unload(name);
            return result;
        }
        return Promise.resolve(this.unloadResident(names));
    }

    async createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo> {
        if (this.live() === null) return { name, size: { width: 0, height: 0 } };

        const entry: AssetManifestEntry = {
            name,
            kind: 'text',
            text,
            ...(style !== undefined && { style }),
        };

        // Measurement uses a 2D canvas, so a real size is available mid-loss: only the upload
        // queues, and layout never blocks.
        const size = measureText(text, style);

        const upload = async (): Promise<AssetInfo> => {
            const app = this.#app;
            if (app === null) return { name, size: { ...size } };
            const raster = rasterizeText(app.renderer, text, style);
            return this.#assets.registerTexture(entry, raster.texture, raster.size);
        };

        const guard = this.#guard;
        if (guard?.lost === true) {
            // Resolves with the measured size now; the restore's merge rasterizes the texture.
            this.queue.load(entry);
            return { name, size: { ...size } };
        }
        return upload();
    }

    getAssetSize(name: string): Readonly<Size> | null {
        return this.#assets.sizeOf(name);
    }

    protected resizeSurface(width: number, height: number, resolution: number): void {
        this.#app?.renderer.resize(width, height, resolution);
    }

    protected get fallbackAssetSize(): Readonly<Size> {
        return PLACEHOLDER_SIZE;
    }

    protected measureTextSize(text: string, style: TextStyle | undefined): Size {
        return measureText(text, style);
    }

    protected residentAssets(): Array<{ name: string; size: Size }> {
        return this.#assets.inspectEntries();
    }

    protected isResident(name: string): boolean {
        return this.#assets.has(name);
    }

    protected kindOf(name: string): AssetManifestEntry['kind'] | null {
        return this.#assets.kindOf(name);
    }

    /** Live nodes on a name, counting an atlas's frame names as uses of the atlas. */
    protected referenceCount(name: string): number {
        const core = this.core;
        let count = core?.referenceCount(name) ?? 0;
        for (const frame of this.#assets.framesOf(name)) {
            count += core?.referenceCount(frame) ?? 0;
        }
        return count;
    }

    protected dropResident(name: string): void {
        // Affected nodes fall back to the placeholder; their ids stay valid. Sprites reference an
        // atlas by BARE FRAME NAME, so the frames the sheet contributed have to be repointed as
        // well — the atlas name itself is usually on no node at all.
        const core = this.core;
        const slots = core?.slotsUsingTexture(name) ?? [];
        for (const frame of this.#assets.framesOf(name)) {
            slots.push(...(core?.slotsUsingTexture(frame) ?? []));
        }
        this.#assets.unload(name);
        this.#sink?.repointToPlaceholder(slots);
    }

    #installObserver(container: HTMLElement): void {
        if (typeof ResizeObserver === 'undefined') return;
        this.#observer = new ResizeObserver(() => {
            const core = this.core;
            if (core === null) return;
            const size = measureContainer(container, core.config.design);
            this.resize(size.width, size.height);
        });
        this.#observer.observe(container);
    }

    #installGuard(app: Application): void {
        // WebGPU exposes device loss as a promise rather than a DOM event, and a WebGL renderer
        // has no `.gpu` at all.
        const gpu = (app.renderer as { gpu?: { device?: { lost?: Promise<unknown> } } }).gpu;
        const deviceLost = gpu?.device?.lost;

        this.#guard = new ContextGuard(this.queue, {
            retainedManifest: () => this.#assets.retainedManifest(),
            reupload: async (work) => this.#reupload(work),
            rebuildScene: () => this.core?.rebuildScene(),
            onLost: (reason) => this.core?.emit('contextlost', { reason }),
            onRestored: (reloadedAssets, failedAssets) =>
                this.core?.emit('contextrestored', { reloadedAssets, failedAssets }),
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
            // A text entry rasterizes rather than fetches, and the registry refuses that kind by
            // design — so routing it through the loader would report every world label as failed.
            if (entry.kind === 'text') {
                this.#assets.unload(entry.name);
                const info = await this.createTextAsset(entry.name, entry.text, entry.style);
                (this.#assets.has(info.name) ? reloaded : failed).push(info.name);
                continue;
            }
            const outcome = await this.#assets.load(entry);
            if (outcome.info !== undefined) reloaded.push(outcome.info.name);
            else if (outcome.failure !== undefined) failed.push(outcome.failure.name);
            for (const collision of outcome.collisions ?? []) failed.push(collision.name);
        }
        return { reloaded, failed };
    }

    /** What a deferred load reports once the restore has applied the queued intents. */
    #loadResultFor(names: readonly string[]): AssetLoadResult {
        const result: AssetLoadResult = { loaded: [], failed: [], queued: true };
        for (const name of names) {
            const size = this.#assets.sizeOf(name);
            if (size === null) result.failed.push({ name, reason: 'not restored' });
            else result.loaded.push({ name, size: { ...size } });
        }
        return result;
    }

    /**
     * The unload a queued intent will perform, reported from residency as it stands now.
     *
     * Names in the order given, not fonts-last: nothing is dropped here, so the reordering that
     * keeps live text off a fallback face would only reshuffle the report.
     */
    #unloadIntent(names: readonly string[]): AssetUnloadResult {
        const result: AssetUnloadResult = { unloaded: [], unknown: [], inUse: [], queued: true };
        for (const name of names) {
            if (this.reportUnload(name, result)) result.unloaded.push(name);
        }
        return result;
    }

    /**
     * Loads entries sequentially on purpose.
     *
     * `Promise.all` would be faster but would make the order of `loaded`/`failed` and the winner of
     * a cross-sheet frame-name collision nondeterministic.
     */
    async #loadNow(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        const result: AssetLoadResult = { loaded: [], failed: [], queued: false };
        for (const entry of entries) {
            // A structurally invalid entry is reported like a 404 rather than thrown, because one
            // bad line in a manifest must not lose the whole level load.
            const invalid = invalidReason(entry);
            if (invalid !== null) {
                result.failed.push({ name: String(entry?.name ?? ''), reason: invalid });
                continue;
            }
            if (entry.kind === 'text') {
                // A text entry rasterizes rather than fetches.
                result.loaded.push(await this.createTextAsset(entry.name, entry.text, entry.style));
                continue;
            }
            const outcome = await this.#assets.load(entry);
            if (outcome.info !== undefined) result.loaded.push(outcome.info);
            if (outcome.failure !== undefined) result.failed.push(outcome.failure);
            // A frame an atlas could not claim is an authoring bug the caller has to hear about.
            if (outcome.collisions !== undefined) result.failed.push(...outcome.collisions);
        }
        return result;
    }
}

/** The reason an entry is unusable, or `null` when it is fine. */
function invalidReason(entry: AssetManifestEntry): string | null {
    try {
        validateAssetEntry(entry);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** What a queued load settles with when the context never comes back. */
function cancelledLoad(names: readonly string[]): AssetLoadResult {
    return {
        loaded: [],
        failed: names.map((name) => ({ name, reason: CANCELLED_REASON })),
        queued: true,
    };
}

/**
 * The container's CSS size, falling back to the design stage.
 *
 * A container measured mid-layout reports 0, and the ResizeObserver corrects the fallback on the
 * first real layout.
 */
function measureContainer(container: HTMLElement, design: Size): Size {
    const width = container.clientWidth;
    const height = container.clientHeight;
    return {
        width: width > 0 ? width : design.width,
        height: height > 0 ? height : design.height,
    };
}

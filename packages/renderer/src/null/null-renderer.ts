// A complete `IRenderer` with no DOM and no GPU, not a stub: everything backend-independent comes
// from `RendererShell` and `RendererCore`, the same classes the Pixi backend uses, so the contract
// suite exercises the real code paths.
//
// What differs lives in `NullSink`: there are no display objects, and sizes come from the manifest
// or a deterministic formula because a headless backend can neither decode a PNG nor measure a
// font.

import type { Size } from '@platform/math';
import type {
    AssetInfo,
    AssetLoadResult,
    AssetManifestEntry,
    ContextState,
    RendererInitOptions,
    Surface,
    TextStyle,
} from '../renderer.js';
import { rendererError } from '../errors.js';
import { surfaceOrder } from '../surfaces.js';
import type { NodeRecord } from '../node-store.js';
import type { NodeId } from '../node-id.js';
import { validateAssetEntry } from '../asset-queue.js';
import type { SceneSink } from '../core/scene-sink.js';
import { RendererCore, resolveInitOptions } from '../core/renderer-core.js';
import { RendererShell } from '../core/renderer-shell.js';
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
function measureTextHeadless(text: string, style: TextStyle | undefined): Size {
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
export class NullRenderer extends RendererShell {
    #sink: NullSink | null = null;

    readonly #assets = new Map<string, ResidentAsset>();

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
        if (this.core !== null) {
            rendererError('already-initialized', 'init() was already called on this renderer');
        }

        // No container to measure, so the design stage is the initial canvas size.
        const canvas = { width: options.design.width, height: options.design.height };
        // No `devicePixelRatio` either: a headless backend has no display.
        const resolution = effectiveResolution(1, options.maxResolution ?? 2);
        const config = resolveInitOptions(options, canvas, resolution);

        this.#sink = new NullSink(this.#assets, config.enabledSurfaces);
        this.core = new RendererCore(this.#sink, config);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownCore();
        this.#sink = null;
        this.#assets.clear();
    }

    render(): void {
        // Resolves and culls for real; there is simply nothing to present afterwards.
        this.live()?.flush();
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

    async createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo> {
        const entry: AssetManifestEntry = {
            name,
            kind: 'text',
            text,
            ...(style !== undefined && { style }),
        };
        return Promise.resolve(this.#loadOne(entry));
    }

    getAssetSize(name: string): Readonly<Size> | null {
        return this.#assets.get(name)?.size ?? null;
    }

    /** Root ids for a surface in draw order. Test-only, for the same reason as `isCulled`. */
    drawOrderOf(surface: Surface): NodeId[] {
        return this.core?.drawOrderOf(surface) ?? [];
    }

    /** Draw order of the surfaces themselves. Test-only. */
    surfaceDrawOrder(): Surface[] {
        const enabled = this.core?.config.enabledSurfaces ?? [];
        return [...enabled].toSorted((a, b) => surfaceOrder(a) - surfaceOrder(b));
    }

    /** No drawing surface at all, so a resize is the recorded size and nothing else. */
    protected resizeSurface(): void {}

    protected get fallbackAssetSize(): Readonly<Size> {
        return UNKNOWN_IMAGE_SIZE;
    }

    protected measureTextSize(text: string, style: TextStyle | undefined): Size {
        return measureTextHeadless(text, style);
    }

    protected residentAssets(): Array<{ name: string; size: Size }> {
        return [...this.#assets].map(([name, asset]) => ({ name, size: { ...asset.size } }));
    }

    protected isResident(name: string): boolean {
        return this.#assets.has(name);
    }

    protected kindOf(name: string): AssetManifestEntry['kind'] | null {
        return this.#assets.get(name)?.entry.kind ?? null;
    }

    protected referenceCount(name: string): number {
        return this.core?.referenceCount(name) ?? 0;
    }

    protected dropResident(name: string): void {
        this.#assets.delete(name);
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

// The shared half of `IRenderer` through a probe backend: the no-op-before-`init`-and-after-
// `destroy` rule and the fonts-last unload are the shell's, and a real backend cannot be asked to
// prove them for it — the probe supplies its own residency and reference counts, so the unload
// policy is reachable without loading a texture or building a scene.

import { describe, expect, it } from 'vitest';
import type { Size } from '@platform/math';
import { RendererCore, resolveInitOptions } from '../src/core/renderer-core.js';
import { emptySnapshot } from '../src/core/scene-snapshot.js';
import { RendererShell } from '../src/core/renderer-shell.js';
import type { SceneSink } from '../src/core/scene-sink.js';
import { NO_NODE } from '../src/node-id.js';
import type { NodeId } from '../src/node-id.js';
import type {
    AssetInfo,
    AssetLoadResult,
    AssetManifestEntry,
    CameraState,
    ContextState,
    RendererInitOptions,
    Surface,
    TextStyle,
} from '../src/renderer.js';

const DESIGN: Size = { width: 800, height: 600 };
const PROBE_SIZE: Size = { width: 4, height: 4 };

const INIT: RendererInitOptions = { design: DESIGN };

/** No display objects: the shell never calls a sink, and the core only needs `sizeOf`. */
class ProbeSink implements SceneSink {
    readonly #visible = new Map<Surface, boolean>();

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

    sizeOf(): Size {
        return PROBE_SIZE;
    }

    surfaceVisible(surface: Surface): boolean {
        return this.#visible.get(surface) ?? true;
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.#visible.set(surface, visible);
    }
}

interface Resident {
    kind: AssetManifestEntry['kind'];
    size: Size;
}

/**
 * The smallest backend that satisfies `RendererShell`.
 *
 * `references` is writable by a test, which is the point of the probe: a backend derives the count
 * from a live scene, so no scene can put a font and a texture in use at once as cheaply.
 */
class ProbeRenderer extends RendererShell {
    readonly references = new Map<string, number>();

    readonly #assets = new Map<string, Resident>();

    get contextState(): ContextState {
        return 'ok';
    }

    get pendingAssetOps(): number {
        return 0;
    }

    async init(options: RendererInitOptions): Promise<void> {
        const config = resolveInitOptions(options, { ...options.design }, 1);
        this.core = new RendererCore(new ProbeSink(), config);
        return Promise.resolve();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownCore();
        this.#assets.clear();
        this.references.clear();
    }

    render(): void {
        this.live()?.flush();
    }

    async loadAsset(entry: AssetManifestEntry): Promise<AssetInfo> {
        this.#assets.set(entry.name, { kind: entry.kind, size: PROBE_SIZE });
        return Promise.resolve({ name: entry.name, size: { ...PROBE_SIZE } });
    }

    async loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult> {
        const loaded = entries.map((entry) => {
            this.#assets.set(entry.name, { kind: entry.kind, size: PROBE_SIZE });
            return { name: entry.name, size: { ...PROBE_SIZE } };
        });
        return Promise.resolve({ loaded, failed: [], queued: false });
    }

    async createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo> {
        return this.loadAsset({ name, kind: 'text', text, ...(style !== undefined && { style }) });
    }

    getAssetSize(name: string): Readonly<Size> | null {
        return this.#assets.get(name)?.size ?? null;
    }

    protected resizeSurface(): void {}

    protected get fallbackAssetSize(): Readonly<Size> {
        return PROBE_SIZE;
    }

    protected measureTextSize(): Size {
        return PROBE_SIZE;
    }

    protected residentAssets(): Array<{ name: string; size: Size }> {
        return [...this.#assets].map(([name, asset]) => ({ name, size: { ...asset.size } }));
    }

    protected isResident(name: string): boolean {
        return this.#assets.has(name);
    }

    protected kindOf(name: string): AssetManifestEntry['kind'] | null {
        return this.#assets.get(name)?.kind ?? null;
    }

    protected referenceCount(name: string): number {
        return this.references.get(name) ?? 0;
    }

    protected dropResident(name: string): void {
        this.#assets.delete(name);
    }
}

const ZERO_BOUNDS = { left: 0, right: 0, top: 0, bottom: 0 };
const ZERO_VEC = { x: 0, y: 0, z: 0 };
const DEFAULT_CAMERA: CameraState = { position: ZERO_VEC, zoom: 1, framing: 'stage' };

interface InertCase {
    readonly member: string;
    readonly call: (renderer: ProbeRenderer) => unknown;
    readonly expected: unknown;
}

const INERT_CASES: readonly InertCase[] = [
    { member: 'initialized', call: (r) => r.initialized, expected: false },
    { member: 'canvasSize', call: (r) => r.canvasSize, expected: { width: 0, height: 0 } },
    { member: 'resolution', call: (r) => r.resolution, expected: 1 },
    { member: 'stageRect', call: (r) => r.stageRect, expected: ZERO_BOUNDS },
    { member: 'viewport', call: (r) => r.viewport, expected: ZERO_BOUNDS },
    { member: 'resize', call: (r) => r.resize(1024, 768), expected: undefined },
    {
        member: 'setSurfaceVisible',
        call: (r) => r.setSurfaceVisible('ui', false),
        expected: undefined,
    },
    { member: 'isSurfaceEnabled', call: (r) => r.isSurfaceEnabled('ui'), expected: false },
    { member: 'hasAsset', call: (r) => r.hasAsset('hero'), expected: false },
    { member: 'getAssetSize', call: (r) => r.getAssetSize('hero'), expected: null },
    {
        member: 'createNode',
        call: (r) => r.createNode({ kind: 'sprite', texture: 'hero', surface: 'world' }),
        expected: NO_NODE,
    },
    {
        member: 'createNodes',
        call: (r) => r.createNodes([{ kind: 'group', surface: 'world' }]),
        expected: [],
    },
    {
        member: 'createSubtree',
        call: (r) =>
            r.createSubtree([
                { kind: 'group', surface: 'world' },
                { kind: 'group', surface: 'world', parentInBatch: 0 },
            ]),
        expected: [],
    },
    { member: 'destroyNode', call: (r) => r.destroyNode(NO_NODE), expected: undefined },
    { member: 'destroyNodes', call: (r) => r.destroyNodes([NO_NODE]), expected: undefined },
    {
        member: 'updateNodes',
        call: (r) => r.updateNodes([{ id: NO_NODE, alpha: 0.5 }]),
        expected: undefined,
    },
    {
        member: 'updateSubtree',
        call: (r) => r.updateSubtree(NO_NODE, { visible: false }),
        expected: undefined,
    },
    { member: 'setNodeText', call: (r) => r.setNodeText(NO_NODE, 'hi'), expected: undefined },
    { member: 'isAlive', call: (r) => r.isAlive(NO_NODE), expected: false },
    { member: 'clear', call: (r) => r.clear(), expected: undefined },
    { member: 'attachNode', call: (r) => r.attachNode(NO_NODE, NO_NODE), expected: undefined },
    { member: 'detachNode', call: (r) => r.detachNode(NO_NODE), expected: undefined },
    { member: 'parentOf', call: (r) => r.parentOf(NO_NODE), expected: NO_NODE },
    { member: 'childrenOf', call: (r) => r.childrenOf(NO_NODE), expected: [] },
    { member: 'surfaceOf', call: (r) => r.surfaceOf(NO_NODE), expected: null },
    { member: 'setCamera', call: (r) => r.setCamera(DEFAULT_CAMERA), expected: undefined },
    { member: 'camera', call: (r) => r.camera, expected: DEFAULT_CAMERA },
    { member: 'localTransformOf', call: (r) => r.localTransformOf(NO_NODE), expected: null },
    { member: 'resolvedTransformOf', call: (r) => r.resolvedTransformOf(NO_NODE), expected: null },
    { member: 'localBoundsOf', call: (r) => r.localBoundsOf(NO_NODE), expected: null },
    { member: 'worldBoundsOf', call: (r) => r.worldBoundsOf(NO_NODE), expected: null },
    { member: 'screenBoundsOf', call: (r) => r.screenBoundsOf(NO_NODE), expected: null },
    { member: 'screenPositionOf', call: (r) => r.screenPositionOf(NO_NODE), expected: null },
    { member: 'worldToScreen', call: (r) => r.worldToScreen(ZERO_VEC), expected: ZERO_VEC },
    { member: 'screenToWorld', call: (r) => r.screenToWorld(ZERO_VEC), expected: ZERO_VEC },
    { member: 'isCulled', call: (r) => r.isCulled(NO_NODE), expected: false },
    { member: 'render', call: (r) => r.render(), expected: undefined },
    { member: 'inspect', call: (r) => r.inspect(), expected: emptySnapshot('ok') },
];

/** A shell with no core, reached either way round: never installed, or torn down. */
async function withoutCore(state: 'before init' | 'after destroy'): Promise<ProbeRenderer> {
    const renderer = new ProbeRenderer();
    if (state === 'before init') return renderer;
    await renderer.init(INIT);
    renderer.destroy();
    return renderer;
}

describe.each(['before init', 'after destroy'] as const)('a shell %s', (state) => {
    it.each(INERT_CASES)('$member is inert', async ({ call, expected }) => {
        const renderer = await withoutCore(state);
        expect(call(renderer)).toEqual(expected);
    });

    it("hands back the caller's array, emptied, from the out-parameter pair", async () => {
        const renderer = await withoutCore(state);
        const out: NodeId[] = [NO_NODE, NO_NODE];

        expect(renderer.childrenOf(NO_NODE, out)).toBe(out);
        expect(out).toEqual([]);
        out.push(NO_NODE);
        expect(renderer.createNodes([{ kind: 'group', surface: 'world' }], out)).toBe(out);
        expect(out).toEqual([]);
    });

    it('subscribes to nothing and hands back an unsubscribe that no-ops', async () => {
        const renderer = await withoutCore(state);
        const off = renderer.on('resize', () => {
            throw new Error('a shell with no core must not emit');
        });

        expect(off()).toBeUndefined();
    });

    it('reports every asked-for name as unknown rather than throwing', async () => {
        const renderer = await withoutCore(state);
        await expect(renderer.unloadAssets(['hero'])).resolves.toEqual({
            unloaded: [],
            unknown: ['hero'],
            inUse: [],
            queued: false,
        });
    });

    it('resolves createNodeAsync with the null handle and the fallback size', async () => {
        const renderer = await withoutCore(state);
        await expect(
            renderer.createNodeAsync({ kind: 'sprite', texture: 'hero', surface: 'world' }),
        ).resolves.toEqual({ id: NO_NODE, name: 'hero', size: PROBE_SIZE });
    });
});

describe('a live shell', () => {
    it('delegates to the core it was handed', async () => {
        const renderer = new ProbeRenderer();
        await renderer.init(INIT);

        expect(renderer.initialized).toBe(true);
        const id = renderer.createNode({ kind: 'sprite', texture: 'hero', surface: 'world' });
        expect(id).not.toBe(NO_NODE);
        expect(renderer.isAlive(id)).toBe(true);
        expect(renderer.canvasSize).toEqual(DESIGN);

        renderer.destroy();
        expect(renderer.isAlive(id)).toBe(false);
    });

    it('stays torn down across a second destroy', async () => {
        const renderer = new ProbeRenderer();
        await renderer.init(INIT);
        renderer.destroy();

        expect(() => renderer.destroy()).not.toThrow();
        expect(renderer.initialized).toBe(false);
    });
});

describe('unloadResident', () => {
    async function loaded(): Promise<ProbeRenderer> {
        const renderer = new ProbeRenderer();
        await renderer.init(INIT);
        await renderer.loadAssets([
            { name: 'hero', kind: 'image', url: '/hero.png' },
            { name: 'Chalk', kind: 'font', url: '/chalk.woff2' },
        ]);
        return renderer;
    }

    it('reports non-fonts before fonts, whatever order they were asked in', async () => {
        const renderer = await loaded();

        const result = await renderer.unloadAssets(['Chalk', 'hero']);
        // Fonts last is an ordering, not just an outcome: a caller replaying `unloaded` must not
        // drop a font before the text still using it.
        expect(result.unloaded).toEqual(['hero', 'Chalk']);
        expect(renderer.hasAsset('hero')).toBe(false);
        expect(renderer.hasAsset('Chalk')).toBe(false);
    });

    it('keeps an in-use font while an in-use texture goes anyway', async () => {
        const renderer = await loaded();
        renderer.references.set('hero', 2);
        renderer.references.set('Chalk', 1);

        const result = await renderer.unloadAssets(['Chalk', 'hero']);
        expect(result.unloaded).toEqual(['hero']);
        expect(result.inUse).toEqual([
            { name: 'hero', nodeCount: 2 },
            { name: 'Chalk', nodeCount: 1 },
        ]);
        expect(renderer.hasAsset('Chalk')).toBe(true);
    });

    it('accepts manifest entries as well as names, and reports the rest as unknown', async () => {
        const renderer = await loaded();

        const result = await renderer.unloadAssets([
            { name: 'hero', kind: 'image', url: '/hero.png' },
            'ghost',
        ]);
        expect(result.unloaded).toEqual(['hero']);
        expect(result.unknown).toEqual(['ghost']);
        expect(result.inUse).toEqual([]);
    });
});

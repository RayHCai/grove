// The null backend against the reusable contract, plus the handful of behaviors that are
// specific to being headless.

import { describe, it, expect } from 'vitest';
import { createNullRenderer, NullRenderer } from '../src/null/index.js';
import { runRendererContract } from './contract/renderer-contract.js';

// The whole contract, against the second implementation of the interface. When a browser-mode
// target exists this same call runs against PixiRenderer.
runRendererContract(() => createNullRenderer(), { name: 'NullRenderer — IRenderer contract' });

const DESIGN = { width: 800, height: 600 };

async function ready(): Promise<NullRenderer> {
    const renderer = new NullRenderer();
    await renderer.init({
        design: DESIGN,
        enabledSurfaces: ['editorSpace', 'world', 'ui', 'editorOverlay', 'editorUi'],
    });
    await renderer.loadAsset({
        name: 'block',
        kind: 'image',
        url: '/block.png',
        size: { width: 64, height: 32 },
    });
    return renderer;
}

describe('NullRenderer — headless specifics', () => {
    it('needs no DOM: init never touches the container', async () => {
        const renderer = new NullRenderer();
        // A Proxy that throws on ANY access proves the container is never dereferenced — the
        // null backend must run where there is no DOM at all.
        const trap = new Proxy(
            {},
            {
                get() {
                    throw new Error('container was dereferenced');
                },
                set() {
                    throw new Error('container was dereferenced');
                },
            },
        ) as HTMLElement;

        await expect(renderer.init({ container: trap, design: DESIGN })).resolves.toBeUndefined();
        expect(renderer.initialized).toBe(true);
        renderer.destroy();
    });

    it('starts with the canvas equal to the design stage', async () => {
        const renderer = await ready();
        expect(renderer.canvasSize).toEqual(DESIGN);
        renderer.destroy();
    });

    it("keeps contextState 'ok' and never queues an asset op", async () => {
        const renderer = await ready();
        expect(renderer.contextState).toBe('ok');
        expect(renderer.pendingAssetOps).toBe(0);

        const load = await renderer.loadAssets([
            { name: 'x', kind: 'image', url: '/x.png', size: { width: 1, height: 1 } },
        ]);
        expect(load.queued).toBe(false);

        const unload = await renderer.unloadAssets(['x']);
        expect(unload.queued).toBe(false);
        expect(renderer.pendingAssetOps).toBe(0);
        renderer.destroy();
    });

    it('measures text deterministically — same input, same size', async () => {
        const a = await ready();
        const b = await ready();
        const first = await a.createTextAsset('t', 'Hello\nWorld', { size: 20 });
        const second = await b.createTextAsset('t', 'Hello\nWorld', { size: 20 });

        expect(first.size).toEqual(second.size);
        a.destroy();
        b.destroy();
    });

    it('scales measured text with the style size', async () => {
        const renderer = await ready();
        const small = await renderer.createTextAsset('s', 'same text', { size: 10 });
        const large = await renderer.createTextAsset('l', 'same text', { size: 20 });

        expect(large.size.width).toBeGreaterThan(small.size.width);
        expect(large.size.height).toBeGreaterThan(small.size.height);
        renderer.destroy();
    });

    it('counts lines in measured height', async () => {
        const renderer = await ready();
        const one = await renderer.createTextAsset('a', 'line', { size: 10 });
        const three = await renderer.createTextAsset('b', 'line\nline\nline', { size: 10 });

        expect(three.size.height).toBeCloseTo(one.size.height * 3, 9);
        renderer.destroy();
    });

    it('falls back to a 1x1 size for an image declaring none', async () => {
        const renderer = await ready();
        const info = await renderer.loadAsset({
            name: 'undeclared',
            kind: 'image',
            url: '/u.png',
        });
        // A headless backend cannot decode a PNG; the documented fallback keeps `AssetInfo`
        // uniform rather than returning null.
        expect(info.size).toEqual({ width: 1, height: 1 });
        renderer.destroy();
    });

    it('keeps an in-use font rather than dropping it', async () => {
        const renderer = await ready();
        await renderer.loadAsset({ name: 'Chalk', kind: 'font', url: '/chalk.woff2' });
        renderer.createNode({
            kind: 'text',
            text: 'hi',
            surface: 'ui',
            style: { font: 'Chalk' },
        });

        const result = await renderer.unloadAssets(['Chalk']);
        // Dropping a live font re-rasterizes to a fallback face, which reads as corruption
        // rather than as a missing asset — so it is kept and reported.
        expect(result.inUse.map((entry) => entry.name)).toContain('Chalk');
        expect(result.unloaded).not.toContain('Chalk');
        expect(renderer.hasAsset('Chalk')).toBe(true);
        renderer.destroy();
    });

    it('unloads a font once nothing references it', async () => {
        const renderer = await ready();
        await renderer.loadAsset({ name: 'Chalk', kind: 'font', url: '/chalk.woff2' });
        const id = renderer.createNode({
            kind: 'text',
            text: 'hi',
            surface: 'ui',
            style: { font: 'Chalk' },
        });
        renderer.destroyNode(id);

        const result = await renderer.unloadAssets(['Chalk']);
        expect(result.unloaded).toContain('Chalk');
        renderer.destroy();
    });
});

describe('NullRenderer — culling', () => {
    it('culls a sprite outside the viewport and draws one inside', async () => {
        const renderer = await ready();
        renderer.resize(800, 600);
        renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

        const near = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        const far = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 100_000, y: 0 },
        });

        renderer.render();
        expect(renderer.isCulled(near)).toBe(false);
        expect(renderer.isCulled(far)).toBe(true);
        renderer.destroy();
    });

    it('never culls a group, a UI node, or a neverCull node', async () => {
        const renderer = await ready();
        renderer.resize(800, 600);
        renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

        const offscreen = { x: 100_000, y: 0 };
        const group = renderer.createNode({
            kind: 'group',
            surface: 'world',
            position: offscreen,
        });
        const uiNode = renderer.createNode({
            kind: 'text',
            text: 'hud',
            surface: 'ui',
            position: offscreen,
        });
        const glow = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: offscreen,
            neverCull: true,
        });

        renderer.render();
        expect(renderer.isCulled(group)).toBe(false);
        expect(renderer.isCulled(uiNode)).toBe(false);
        expect(renderer.isCulled(glow)).toBe(false);
        renderer.destroy();
    });

    it('does not let a culled parent hide its children', async () => {
        const renderer = await ready();
        renderer.resize(800, 600);
        renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

        // The parent sits far off screen; the child's own position pulls it back on screen.
        const parent = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 100_000, y: 0 },
        });
        const child = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            parent,
            position: { x: -100_000, y: 0 },
        });

        renderer.render();
        expect(renderer.isCulled(parent)).toBe(true);
        // Culling toggles the ART only — a child is a sibling of its parent's art, so it is
        // structurally incapable of being hidden by the parent's cull.
        expect(renderer.isCulled(child)).toBe(false);
        renderer.destroy();
    });

    it('draws a node just outside the viewport thanks to the world-px margin', async () => {
        const renderer = new NullRenderer();
        await renderer.init({ design: DESIGN, cullMargin: 64 });
        await renderer.loadAsset({
            name: 'block',
            kind: 'image',
            url: '/b.png',
            size: { width: 64, height: 32 },
        });
        renderer.resize(800, 600);
        renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

        // Viewport right edge is 400; the sprite's half-width is 32, so its left edge sits at
        // 420 — outside, but inside the 64px margin.
        const id = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 452, y: 0 },
        });

        renderer.render();
        expect(renderer.isCulled(id)).toBe(false);
        renderer.destroy();
    });
});

describe('NullRenderer — draw order', () => {
    it('orders roots by layer', async () => {
        const renderer = await ready();
        const back = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            layer: -5,
        });
        const front = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            layer: 10,
        });
        const middle = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            layer: 0,
        });

        expect(renderer.drawOrderOf('world')).toEqual([back, middle, front]);
        renderer.destroy();
    });

    it('breaks a layer tie by insertion order', async () => {
        const renderer = await ready();
        const first = renderer.createNode({ kind: 'group', surface: 'world', layer: 3 });
        const second = renderer.createNode({ kind: 'group', surface: 'world', layer: 3 });

        // Insertion-defined and stable — one fewer source of visual nondeterminism.
        expect(renderer.drawOrderOf('world')).toEqual([first, second]);
        renderer.destroy();
    });

    it('reorders when a layer is patched', async () => {
        const renderer = await ready();
        const a = renderer.createNode({ kind: 'group', surface: 'world', layer: 0 });
        const b = renderer.createNode({ kind: 'group', surface: 'world', layer: 1 });

        expect(renderer.drawOrderOf('world')).toEqual([a, b]);
        renderer.updateNodes([{ id: a, layer: 5 }]);
        expect(renderer.drawOrderOf('world')).toEqual([b, a]);
        renderer.destroy();
    });

    it('stacks the surfaces bottom to top, editorOverlay above ui', async () => {
        const renderer = await ready();
        expect(renderer.surfaceDrawOrder()).toEqual([
            'editorSpace',
            'world',
            'ui',
            'editorOverlay',
            'editorUi',
        ]);
        renderer.destroy();
    });
});

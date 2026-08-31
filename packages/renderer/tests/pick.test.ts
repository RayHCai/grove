// `nodeAt` — the pointer's question, answered in the space a pointer event arrives in.
//
// Screen space and y-down throughout, which is what lets one call serve a UI widget and a world
// sprite without the caller knowing which it hit. The scene below is deliberately built at zoom 1
// with the camera at the origin, so a world point and a screen point differ only by the centring
// offset the numbers state explicitly.

import { describe, expect, it } from 'vitest';
import { NO_NODE } from '../src/node-id.js';
import { NullRenderer } from '../src/null/index.js';

const DESIGN = { width: 800, height: 600 };
/** The screen point the world origin projects to at zoom 1, centred. */
const CENTRE = { x: 400, y: 300 };

async function ready(): Promise<NullRenderer> {
    const renderer = new NullRenderer();
    await renderer.init({ design: DESIGN, enabledSurfaces: ['world', 'ui'] });
    renderer.resize(DESIGN.width, DESIGN.height);
    renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    // 64x32, so a sprite at the origin covers x 368..432 and y 284..316 on screen.
    await renderer.loadAsset({
        name: 'block',
        kind: 'image',
        url: '/block.png',
        size: { width: 64, height: 32 },
    });
    return renderer;
}

describe('nodeAt', () => {
    it('answers the sprite under the point, and NO_NODE beside it', async () => {
        const renderer = await ready();
        const block = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });

        expect(renderer.nodeAt(CENTRE)).toBe(block);
        // Just outside the 64-wide box: 400 + 33 clears the right edge at 432.
        expect(renderer.nodeAt({ x: 433, y: 300 })).toBe(NO_NODE);
        expect(renderer.nodeAt({ x: 400, y: 317 })).toBe(NO_NODE);
        renderer.destroy();
    });

    it('hits the edge of the box, since a pixel on the art is on the art', async () => {
        const renderer = await ready();
        const block = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });

        expect(renderer.nodeAt({ x: 368, y: 284 })).toBe(block);
        expect(renderer.nodeAt({ x: 432, y: 316 })).toBe(block);
        renderer.destroy();
    });

    it('prefers the greater layer where two overlap', async () => {
        const renderer = await ready();
        const under = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
            layer: 1,
        });
        const over = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
            layer: 5,
        });

        expect(renderer.nodeAt(CENTRE)).toBe(over);
        expect(under).not.toBe(over);
        renderer.destroy();
    });

    it('prefers the most recent where layer ties, as the draw does', async () => {
        const renderer = await ready();
        renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        const later = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });

        expect(renderer.nodeAt(CENTRE)).toBe(later);
        renderer.destroy();
    });

    it('prefers a UI node over a world one, whatever their layers', async () => {
        const renderer = await ready();
        renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
            layer: 900,
        });
        const widget = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'ui',
            uiAnchor: 'center',
            position: { x: 0, y: 0 },
            layer: 0,
        });

        // Surface order beats `layer` by construction: a UI node can never sort beneath a world one.
        expect(renderer.nodeAt(CENTRE)).toBe(widget);
        renderer.destroy();
    });

    it('narrows to one surface when asked', async () => {
        const renderer = await ready();
        const world = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'ui',
            uiAnchor: 'center',
            position: { x: 0, y: 0 },
        });

        expect(renderer.nodeAt(CENTRE, { surface: 'world' })).toBe(world);
        renderer.destroy();
    });

    it('never hits a group — it has no art to cover a pixel with', async () => {
        const renderer = await ready();
        renderer.createNode({ kind: 'group', surface: 'world', position: { x: 0, y: 0 } });
        expect(renderer.nodeAt(CENTRE)).toBe(NO_NODE);
        renderer.destroy();
    });

    it('never hits an invisible node, or one whose parent is', async () => {
        const renderer = await ready();
        const hidden = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
            visible: false,
        });
        expect(renderer.nodeAt(CENTRE)).toBe(NO_NODE);

        // Visibility inherits, so a child of a hidden parent is not on screen either.
        const parent = renderer.createNode({
            kind: 'group',
            surface: 'world',
            position: { x: 0, y: 0 },
            visible: false,
        });
        const child = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        renderer.attachNode(child, parent);
        expect(renderer.nodeAt(CENTRE)).toBe(NO_NODE);
        expect(hidden).not.toBe(child);
        renderer.destroy();
    });

    it('follows the camera, because the point is screen space', async () => {
        const renderer = await ready();
        const block = renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        expect(renderer.nodeAt(CENTRE)).toBe(block);

        // Pan 200 world px right: the sprite is now 200 screen px left of centre.
        renderer.setCamera({ position: { x: 200, y: 0 }, zoom: 1 });
        expect(renderer.nodeAt(CENTRE)).toBe(NO_NODE);
        expect(renderer.nodeAt({ x: 200, y: 300 })).toBe(block);
        renderer.destroy();
    });

    it('answers NO_NODE before init and after destroy', async () => {
        const fresh = new NullRenderer();
        expect(fresh.nodeAt(CENTRE)).toBe(NO_NODE);

        const renderer = await ready();
        renderer.createNode({
            kind: 'sprite',
            texture: 'block',
            surface: 'world',
            position: { x: 0, y: 0 },
        });
        renderer.destroy();
        expect(renderer.nodeAt(CENTRE)).toBe(NO_NODE);
    });
});

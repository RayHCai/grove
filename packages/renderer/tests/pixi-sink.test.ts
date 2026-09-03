// Placement, in the real Pixi backend, with no GPU: `Container`, `Sprite` and `Text` are plain
// objects, so everything below `Application` is testable in Node. This is the seam the contract
// suite cannot reach, because it runs against the headless sink, which draws nothing.

import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { bounds } from '@platform/math';
import { AssetRegistry } from '../src/pixi/asset-registry.js';
import { PixiSink } from '../src/pixi/pixi-sink.js';
import { SurfaceTree } from '../src/pixi/surface-tree.js';
import { TransformStore } from '../src/transform-store.js';
import { NO_PARENT } from '../src/core/scene-sink.js';
import type { NodeRecord } from '../src/node-store.js';
import type { Surface } from '../src/renderer.js';

const DESIGN = { width: 800, height: 600 };

function record(over: Partial<NodeRecord> = {}): NodeRecord {
    return {
        kind: 'sprite',
        surface: 'world',
        texture: 'block',
        text: '',
        style: undefined,
        uiAnchor: undefined,
        layer: 0,
        ordinal: 0,
        ...over,
    };
}

/** A sink over real Pixi containers, plus the store it reads. */
function harness(surfaces: readonly Surface[] = ['world', 'ui']) {
    const xf = new TransformStore();
    const tree = new SurfaceTree(new Container(), surfaces);
    const sink = new PixiSink(tree, new AssetRegistry());
    sink.bind(xf);
    return { xf, tree, sink };
}

/** Where a node's xform actually sits inside its surface root, after composition. */
function screenPosition(
    tree: SurfaceTree,
    surface: Surface,
    xform: Container,
): { x: number; y: number } {
    const root = tree.root(surface);
    if (root === undefined) throw new Error(`surface '${surface}' has no root`);
    let x = xform.position.x;
    let y = xform.position.y;
    for (let node = xform.parent; node !== null && node !== root; node = node.parent) {
        x = node.position.x + x * node.scale.x;
        y = node.position.y + y * node.scale.y;
    }
    return { x: root.position.x + x * root.scale.x, y: root.position.y + y * root.scale.y };
}

describe('PixiSink placement', () => {
    describe('world surface', () => {
        it('flips y at the write boundary and leaves scale positive', () => {
            const { xf, sink } = harness();
            const world = record();

            xf.initSlot(0);
            sink.create(0, world, NO_PARENT);
            xf.setPosition(0, 30, 40, 0);
            sink.write(0, world);

            const objects = sink.objectsAt(0);
            expect(objects?.xform.position.x).toBe(30);
            expect(objects?.xform.position.y).toBe(-40);
        });

        it('does not scale world art by fitScale', () => {
            const { xf, sink } = harness();
            const world = record();

            xf.initSlot(0);
            sink.create(0, world, NO_PARENT);
            xf.setScale(0, 2, 2, 1);
            // A 1600x1200 canvas against an 800x600 design is fitScale 2.
            sink.applyView(
                { position: { x: 0, y: 0 }, zoom: 1, framing: 'stage' },
                'fit',
                { width: 1600, height: 1200 },
                DESIGN,
                bounds(),
                true,
            );
            sink.write(0, world);

            expect(sink.objectsAt(0)?.art?.scale.x).toBe(2);
        });
    });

    describe('ui surface', () => {
        /** A sink whose stage rect is the design stage on an identically sized canvas. */
        function uiHarness(canvas = { width: 800, height: 600 }) {
            const h = harness();
            const scale = Math.min(canvas.width / DESIGN.width, canvas.height / DESIGN.height);
            const stage = bounds();
            stage.left = (canvas.width - DESIGN.width * scale) / 2;
            stage.right = stage.left + DESIGN.width * scale;
            stage.top = (canvas.height - DESIGN.height * scale) / 2;
            stage.bottom = stage.top + DESIGN.height * scale;
            h.sink.applyView(
                { position: { x: 0, y: 0 }, zoom: 1, framing: 'stage' },
                'fit',
                canvas,
                DESIGN,
                stage,
                true,
            );
            return h;
        }

        it('places a top-left anchored node y-DOWN from the stage top-left', () => {
            const { xf, sink, tree } = uiHarness();
            const hud = record({ kind: 'text', surface: 'ui', uiAnchor: 'top-left', texture: '' });

            xf.initSlot(0);
            sink.create(0, hud, NO_PARENT);
            xf.setPosition(0, 20, 20, 0);
            sink.write(0, hud);

            const xform = sink.objectsAt(0)?.xform;
            expect(xform).toBeDefined();
            // Not (20, -20): a UI offset is y-down, so it must not take the world flip.
            expect(screenPosition(tree, 'ui', xform as Container)).toEqual({ x: 20, y: 20 });
        });

        it('places a bottom-right anchored node against the far corner', () => {
            const { xf, sink, tree } = uiHarness();
            const hud = record({
                kind: 'group',
                surface: 'ui',
                uiAnchor: 'bottom-right',
                texture: '',
            });

            xf.initSlot(0);
            sink.create(0, hud, NO_PARENT);
            xf.setPosition(0, -100, -50, 0);
            sink.write(0, hud);

            const xform = sink.objectsAt(0)?.xform as Container;
            expect(screenPosition(tree, 'ui', xform)).toEqual({ x: 700, y: 550 });
        });

        it('scales offsets and art by fitScale', () => {
            const { xf, sink, tree } = uiHarness({ width: 1600, height: 1200 });
            const hud = record({ surface: 'ui', uiAnchor: 'top-left' });

            xf.initSlot(0);
            sink.create(0, hud, NO_PARENT);
            xf.setPosition(0, 20, 20, 0);
            xf.setScale(0, 1, 1, 1);
            sink.write(0, hud);

            const objects = sink.objectsAt(0);
            expect(screenPosition(tree, 'ui', objects?.xform as Container)).toEqual({
                x: 40,
                y: 40,
            });
            // A HUD authored in design px has to grow with the stage, art included.
            expect(objects?.art?.scale.x).toBe(2);
        });

        it('re-places anchored nodes when the stage changes', () => {
            const { xf, sink, tree } = uiHarness();
            const hud = record({
                kind: 'group',
                surface: 'ui',
                uiAnchor: 'bottom-right',
                texture: '',
            });

            xf.initSlot(0);
            sink.create(0, hud, NO_PARENT);
            xf.setPosition(0, 0, 0, 0);
            sink.write(0, hud);
            expect(screenPosition(tree, 'ui', sink.objectsAt(0)?.xform as Container)).toEqual({
                x: 800,
                y: 600,
            });

            const stage = bounds();
            stage.left = 0;
            stage.right = 1600;
            stage.top = 0;
            stage.bottom = 1200;
            sink.applyView(
                { position: { x: 0, y: 0 }, zoom: 1, framing: 'stage' },
                'fit',
                { width: 1600, height: 1200 },
                DESIGN,
                stage,
                true,
            );

            expect(screenPosition(tree, 'ui', sink.objectsAt(0)?.xform as Container)).toEqual({
                x: 1600,
                y: 1200,
            });
        });

        it('adds the anchor origin once, at the surface root, not per child', () => {
            const { xf, sink, tree } = uiHarness();
            const parent = record({
                kind: 'group',
                surface: 'ui',
                uiAnchor: 'bottom-right',
                texture: '',
            });
            const child = record({ surface: 'ui' });

            xf.initSlot(0);
            sink.create(0, parent, NO_PARENT);
            xf.setPosition(0, -100, -50, 0);
            sink.write(0, parent);

            xf.initSlot(1);
            xf.link(1, 0);
            sink.create(1, child, 0);
            xf.setPosition(1, 0, 0, 0);
            sink.write(1, child);

            // The child sits exactly on its parent: one origin, contributed by the root.
            expect(screenPosition(tree, 'ui', sink.objectsAt(1)?.xform as Container)).toEqual({
                x: 700,
                y: 550,
            });
        });
    });

    it('destroys the pair when there is nothing to attach it to', () => {
        const { xf, sink } = harness(['world']);
        const orphan = record({ surface: 'ui' });

        xf.initSlot(0);
        sink.create(0, orphan, NO_PARENT);

        expect(sink.objectsAt(0)).toBeUndefined();
    });
});

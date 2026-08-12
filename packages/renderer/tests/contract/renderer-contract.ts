// The reusable renderer contract (§15).
//
// `runRendererContract(() => createNullRenderer())` today; the SAME suite runs unchanged against
// `PixiRenderer` once a browser-mode vitest target exists, and it is the acceptance test if a
// Three.js backend ever appears. That is the whole reason it exists — an interface validated
// against one implementation is just that implementation's shape.
//
// BACKEND-AGNOSTIC BY CONSTRUCTION: this file may only touch `IRenderer` members plus whatever
// arrives through `opts`. It imports no backend, no pixi, and assumes no GPU. Where backends
// legitimately differ — a real PNG's decoded size vs. the headless backend's declared size — the
// expectation comes in through `opts` rather than being hard-coded.

import { describe, it, expect } from 'vitest';
import type { IRenderer, NodeDesc, Surface } from '../../src/renderer.js';
import { NO_NODE } from '../../src/node-id.js';
import { RendererError } from '../../src/errors.js';

export interface RendererContractOptions {
    /** Label for the describe block, so two backends' results are told apart. */
    name?: string;
    /**
     * A loadable image entry plus the size the backend is expected to report for it.
     *
     * The default declares its own `size`, which every backend must honour: a headless backend
     * cannot decode an image, and a GPU backend should prefer the manifest over a fetch.
     */
    image?: { name: string; url: string; size: { width: number; height: number } };
    /** Surfaces the backend under test should enable. All five, so surface rules are testable. */
    surfaces?: readonly Surface[];
}

const DESIGN = { width: 800, height: 600 };

/**
 * Runs the contract. Calls `describe`/`it` internally, so a caller is one line.
 */
export function runRendererContract(
    makeRenderer: () => IRenderer,
    opts: RendererContractOptions = {},
): void {
    const label = opts.name ?? 'IRenderer contract';
    const image = opts.image ?? {
        name: 'block',
        url: '/test/block.png',
        size: { width: 64, height: 32 },
    };
    const surfaces = opts.surfaces ?? (['editorSpace', 'world', 'ui', 'editorOverlay'] as const);

    /** An initialized renderer with the test image loaded. */
    async function ready(): Promise<IRenderer> {
        const renderer = makeRenderer();
        await renderer.init({
            // Not dereferenced by a headless backend; a DOM backend needs a real element and
            // supplies its own via `opts` in that environment.
            container: undefined as unknown as HTMLElement,
            design: DESIGN,
            enabledSurfaces: surfaces,
        });
        await renderer.loadAsset({
            name: image.name,
            kind: 'image',
            url: image.url,
            size: image.size,
        });
        return renderer;
    }

    /** A world sprite using the loaded test image. */
    function sprite(extra: Partial<NodeDesc> = {}): NodeDesc {
        return { kind: 'sprite', texture: image.name, surface: 'world', ...extra } as NodeDesc;
    }

    describe(label, () => {
        // ─── lifecycle ──────────────────────────────────────────────

        describe('lifecycle', () => {
            it('reports initialized only after init', async () => {
                const renderer = makeRenderer();
                expect(renderer.initialized).toBe(false);
                await renderer.init({
                    container: undefined as unknown as HTMLElement,
                    design: DESIGN,
                    enabledSurfaces: surfaces,
                });
                expect(renderer.initialized).toBe(true);
                renderer.destroy();
            });

            it('rejects a second init', async () => {
                const renderer = await ready();
                await expect(
                    renderer.init({
                        container: undefined as unknown as HTMLElement,
                        design: DESIGN,
                    }),
                ).rejects.toBeInstanceOf(RendererError);
                renderer.destroy();
            });

            it('rejects a non-positive design size', async () => {
                const renderer = makeRenderer();
                await expect(
                    renderer.init({
                        container: undefined as unknown as HTMLElement,
                        design: { width: 0, height: 600 },
                    }),
                ).rejects.toBeInstanceOf(RendererError);
            });

            it('survives destroy() and leaves later calls as no-ops', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());
                renderer.destroy();

                expect(() => {
                    renderer.updateNodes([{ id, position: { x: 1, y: 1 } }]);
                    renderer.render();
                    renderer.destroyNode(id);
                    renderer.clear();
                }).not.toThrow();
                // Idempotent.
                expect(() => renderer.destroy()).not.toThrow();
            });
        });

        // ─── handles ────────────────────────────────────────────────

        describe('handle lifecycle', () => {
            it('mints live, distinct, non-null handles', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite());
                const b = renderer.createNode(sprite());

                expect(a).not.toBe(NO_NODE);
                expect(b).not.toBe(NO_NODE);
                expect(a).not.toBe(b);
                expect(renderer.isAlive(a)).toBe(true);
                expect(renderer.isAlive(b)).toBe(true);
                renderer.destroy();
            });

            it('reuses a freed slot but never reissues the freed handle', async () => {
                const renderer = await ready();
                const first = renderer.createNode(sprite());
                renderer.destroyNode(first);
                const second = renderer.createNode(sprite());

                // The freelist may hand back the same slot, but the generation must differ, so
                // the old handle can never validate again (§7).
                expect(second).not.toBe(first);
                expect(renderer.isAlive(first)).toBe(false);
                expect(renderer.isAlive(second)).toBe(true);
                renderer.destroy();
            });

            it('treats NO_NODE as dead', async () => {
                const renderer = await ready();
                expect(renderer.isAlive(NO_NODE)).toBe(false);
                renderer.destroy();
            });
        });

        describe('stale handles are no-ops, not throws (§7)', () => {
            it('accepts every method on a destroyed node without throwing', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());
                const other = renderer.createNode(sprite());
                renderer.destroyNode(id);

                // A stale handle arises from a legitimate race — `entity.destroy()` mid-frame
                // — so each of these must degrade quietly.
                expect(() => {
                    renderer.updateNodes([{ id, position: { x: 5, y: 5 }, alpha: 0.5 }]);
                    renderer.updateSubtree(id, { alpha: 0.5 });
                    renderer.setNodeText(id, 'x');
                    renderer.destroyNode(id);
                    renderer.destroyNodes([id]);
                    renderer.attachNode(id, other);
                    renderer.attachNode(other, id);
                    renderer.detachNode(id);
                }).not.toThrow();

                expect(renderer.parentOf(id)).toBe(NO_NODE);
                expect(renderer.childrenOf(id)).toEqual([]);
                expect(renderer.surfaceOf(id)).toBeNull();
                expect(renderer.localTransformOf(id)).toBeNull();
                expect(renderer.resolvedTransformOf(id)).toBeNull();
                expect(renderer.localBoundsOf(id)).toBeNull();
                expect(renderer.worldBoundsOf(id)).toBeNull();
                expect(renderer.screenBoundsOf(id)).toBeNull();
                expect(renderer.screenPositionOf(id)).toBeNull();
                renderer.destroy();
            });
        });

        // ─── inheritance ────────────────────────────────────────────

        describe('position-only inheritance (§5)', () => {
            it('adds a parent position into a child', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 100, y: 50 } }));
                const child = renderer.createNode(sprite({ parent, position: { x: 10, y: -5 } }));

                const resolved = renderer.resolvedTransformOf(child);
                expect(resolved?.position.x).toBe(110);
                expect(resolved?.position.y).toBe(45);
                renderer.destroy();
            });

            it('does NOT pass rotation, scale, alpha or tint to a child', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(
                    sprite({
                        rotation: 90,
                        scale: { x: 3, y: 3 },
                        alpha: 0.25,
                        tint: 0xff0000,
                    }),
                );
                const child = renderer.createNode(sprite({ parent }));

                // The child keeps its own defaults under a fully-transformed parent. This is
                // the single most important assertion in the suite: §5's rule is what the whole
                // §6.2 tree shape exists to enforce.
                const resolved = renderer.resolvedTransformOf(child);
                expect(resolved?.rotation).toBe(0);
                expect(resolved?.scale.x).toBe(1);
                expect(resolved?.scale.y).toBe(1);
                expect(resolved?.alpha).toBe(1);
                renderer.destroy();
            });

            it('keeps local and resolved identical for the non-inheriting channels', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 7, y: 7 } }));
                const child = renderer.createNode(
                    sprite({ parent, rotation: 30, scale: { x: 2, y: 0.5 }, alpha: 0.5 }),
                );

                const local = renderer.localTransformOf(child);
                const resolved = renderer.resolvedTransformOf(child);
                // Only position and visible may differ between the two (§6.1).
                expect(resolved?.rotation).toBe(local?.rotation);
                expect(resolved?.scale.x).toBe(local?.scale.x);
                expect(resolved?.scale.y).toBe(local?.scale.y);
                expect(resolved?.alpha).toBe(local?.alpha);
                expect(resolved?.position.x).not.toBe(local?.position.x);
                renderer.destroy();
            });

            it('inherits visibility down a 3-deep chain', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite());
                const b = renderer.createNode(sprite({ parent: a }));
                const c = renderer.createNode(sprite({ parent: b }));

                renderer.updateNodes([{ id: a, visible: false }]);
                expect(renderer.resolvedTransformOf(c)?.visible).toBe(false);
                // The LOCAL flag is untouched.
                expect(renderer.localTransformOf(c)?.visible).toBe(true);

                renderer.updateNodes([{ id: a, visible: true }]);
                expect(renderer.resolvedTransformOf(c)?.visible).toBe(true);
                renderer.destroy();
            });

            it('composes exactly over a deep chain', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite({ position: { x: 100, y: 0 } }));
                const b = renderer.createNode(sprite({ parent: a, position: { x: 10, y: 5 } }));
                const c = renderer.createNode(sprite({ parent: b, position: { x: 1, y: 2 } }));

                expect(renderer.resolvedTransformOf(c)?.position.x).toBe(111);
                expect(renderer.resolvedTransformOf(c)?.position.y).toBe(7);

                // Moving the middle node carries the leaf.
                renderer.updateNodes([{ id: b, position: { x: 20, y: 5 } }]);
                expect(renderer.resolvedTransformOf(c)?.position.x).toBe(121);
                renderer.destroy();
            });
        });

        // ─── hierarchy ──────────────────────────────────────────────

        describe('hierarchy', () => {
            it('reports parents and children', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const first = renderer.createNode(sprite({ parent }));
                const second = renderer.createNode(sprite({ parent }));

                expect(renderer.parentOf(first)).toBe(parent);
                expect(renderer.parentOf(parent)).toBe(NO_NODE);
                // Insertion-defined order (§11.1).
                expect(renderer.childrenOf(parent)).toEqual([first, second]);
                renderer.destroy();
            });

            it('reinterprets on attach and preserves on detach (§11.1)', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 100, y: 0 } }));
                const child = renderer.createNode(sprite({ position: { x: 10, y: 0 } }));

                // attach defaults to keepResolvedPosition: false — "position becomes local to
                // parent", so the resolved position MOVES.
                renderer.attachNode(child, parent);
                expect(renderer.resolvedTransformOf(child)?.position.x).toBe(110);
                expect(renderer.localTransformOf(child)?.position.x).toBe(10);

                // detach defaults to true — "keeps world position", so the resolved position
                // STAYS and the local one absorbs it.
                renderer.detachNode(child);
                expect(renderer.resolvedTransformOf(child)?.position.x).toBe(110);
                expect(renderer.localTransformOf(child)?.position.x).toBe(110);
                renderer.destroy();
            });

            it('honours an explicit keepResolvedPosition on attach', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 100, y: 0 } }));
                const child = renderer.createNode(sprite({ position: { x: 10, y: 0 } }));

                renderer.attachNode(child, parent, { keepResolvedPosition: true });
                expect(renderer.resolvedTransformOf(child)?.position.x).toBe(10);
                expect(renderer.localTransformOf(child)?.position.x).toBe(-90);
                renderer.destroy();
            });

            it('honours an explicit keepResolvedPosition: false on detach', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 100, y: 0 } }));
                const child = renderer.createNode(sprite({ parent, position: { x: 10, y: 0 } }));

                renderer.detachNode(child, { keepResolvedPosition: false });
                expect(renderer.resolvedTransformOf(child)?.position.x).toBe(10);
                renderer.destroy();
            });

            it('throws on a cycle', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite());
                const b = renderer.createNode(sprite({ parent: a }));

                // A caller bug, not a race (§7).
                expect(() => renderer.attachNode(a, b)).toThrow(RendererError);
                renderer.destroy();
            });

            it('throws on self-parenting', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite());
                expect(() => renderer.attachNode(a, a)).toThrow(RendererError);
                renderer.destroy();
            });

            it('throws on cross-surface parenting', async () => {
                const renderer = await ready();
                const worldNode = renderer.createNode(sprite({ surface: 'world' }));

                expect(() =>
                    renderer.createNode({
                        kind: 'text',
                        text: 'hi',
                        surface: 'ui',
                        parent: worldNode,
                    }),
                ).toThrow(RendererError);
                renderer.destroy();
            });
        });

        describe('destroy cascade (§11.1)', () => {
            it('invalidates every descendant handle', async () => {
                const renderer = await ready();
                const root = renderer.createNode(sprite());
                const mid = renderer.createNode(sprite({ parent: root }));
                const leaf = renderer.createNode(sprite({ parent: mid }));
                const sibling = renderer.createNode(sprite());

                renderer.destroyNode(root);

                expect(renderer.isAlive(root)).toBe(false);
                expect(renderer.isAlive(mid)).toBe(false);
                expect(renderer.isAlive(leaf)).toBe(false);
                // An unrelated node is untouched.
                expect(renderer.isAlive(sibling)).toBe(true);
                renderer.destroy();
            });

            it('leaves the parent consistent when a child is destroyed', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const first = renderer.createNode(sprite({ parent }));
                const second = renderer.createNode(sprite({ parent }));

                renderer.destroyNode(first);
                expect(renderer.childrenOf(parent)).toEqual([second]);
                renderer.destroy();
            });

            it('clear(surface) drops only that surface', async () => {
                const renderer = await ready();
                const worldNode = renderer.createNode(sprite({ surface: 'world' }));
                const uiNode = renderer.createNode({
                    kind: 'text',
                    text: 'score',
                    surface: 'ui',
                });

                renderer.clear('world');
                expect(renderer.isAlive(worldNode)).toBe(false);
                expect(renderer.isAlive(uiNode)).toBe(true);

                // Assets survive a clear — it drops nodes, not the canvas or the registry.
                expect(renderer.hasAsset(image.name)).toBe(true);
                renderer.destroy();
            });
        });

        // ─── batching and patches ───────────────────────────────────

        describe('updateNodes', () => {
            it('treats an undefined field as unchanged', async () => {
                const renderer = await ready();
                const id = renderer.createNode(
                    sprite({ position: { x: 5, y: 5 }, rotation: 45, alpha: 0.5 }),
                );

                renderer.updateNodes([{ id, position: { x: 9, y: 9 } }]);
                const t = renderer.localTransformOf(id);
                expect(t?.position.x).toBe(9);
                expect(t?.rotation).toBe(45);
                expect(t?.alpha).toBe(0.5);
                renderer.destroy();
            });

            it('retains nothing past the call, so a pooled patch array is safe', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());

                // The pattern §11.1 promises: refill one array every frame, zero allocation.
                const pooled = [{ id, position: { x: 0, y: 0 } }];
                pooled[0]!.position.x = 3;
                renderer.updateNodes(pooled);
                pooled[0]!.position.x = 7;
                renderer.updateNodes(pooled);
                expect(renderer.localTransformOf(id)?.position.x).toBe(7);

                // Mutating the array afterwards must not reach the renderer.
                pooled[0]!.position.x = 999;
                expect(renderer.localTransformOf(id)?.position.x).toBe(7);
                renderer.destroy();
            });

            it('applies z, defaulting an omitted one to 0', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite({ position: { x: 1, y: 2, z: 3 } }));
                expect(renderer.localTransformOf(id)?.position.z).toBe(3);

                renderer.updateNodes([{ id, position: { x: 1, y: 2 } }]);
                expect(renderer.localTransformOf(id)?.position.z).toBe(0);
                renderer.destroy();
            });

            it('ignores a texture patch on a non-sprite node', async () => {
                const renderer = await ready();
                const group = renderer.createNode({ kind: 'group', surface: 'world' });
                expect(() =>
                    renderer.updateNodes([{ id: group, texture: image.name }]),
                ).not.toThrow();
                renderer.destroy();
            });

            it('createNodes fills and returns the out array', async () => {
                const renderer = await ready();
                const out: ReturnType<IRenderer['createNode']>[] = [];
                const ids = renderer.createNodes([sprite(), sprite(), sprite()], out);

                expect(ids).toBe(out);
                expect(ids).toHaveLength(3);
                expect(new Set(ids).size).toBe(3);
                for (const id of ids) expect(renderer.isAlive(id)).toBe(true);
                renderer.destroy();
            });

            it('createNodes parents to an already-existing node (§11.1)', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const [a, b] = renderer.createNodes([sprite({ parent }), sprite({ parent })]);

                expect(renderer.childrenOf(parent)).toEqual([a, b]);
                renderer.destroy();
            });
        });

        describe('updateSubtree is set-only (§5.1)', () => {
            it('writes every descendant and includes the root by default', async () => {
                const renderer = await ready();
                const root = renderer.createNode(sprite({ alpha: 1 }));
                const mid = renderer.createNode(sprite({ parent: root, alpha: 0.9 }));
                const leaf = renderer.createNode(sprite({ parent: mid, alpha: 0.2 }));

                renderer.updateSubtree(root, { alpha: 0.5 });

                // FLATTENS rather than scaling proportionally — the stated cost of set
                // semantics (§5.1).
                expect(renderer.localTransformOf(root)?.alpha).toBe(0.5);
                expect(renderer.localTransformOf(mid)?.alpha).toBe(0.5);
                expect(renderer.localTransformOf(leaf)?.alpha).toBe(0.5);
                renderer.destroy();
            });

            it('omits the root when asked', async () => {
                const renderer = await ready();
                const root = renderer.createNode(sprite({ alpha: 1 }));
                const child = renderer.createNode(sprite({ parent: root, alpha: 1 }));

                renderer.updateSubtree(root, { alpha: 0.25 }, { includeRoot: false });
                expect(renderer.localTransformOf(root)?.alpha).toBe(1);
                expect(renderer.localTransformOf(child)?.alpha).toBe(0.25);
                renderer.destroy();
            });

            it('establishes no inheritance — a later child is unaffected', async () => {
                const renderer = await ready();
                const root = renderer.createNode(sprite());
                renderer.updateSubtree(root, { alpha: 0.5 });

                const late = renderer.createNode(sprite({ parent: root }));
                // A one-shot fan-out, not a mode: the new child keeps the default (§5.1).
                expect(renderer.localTransformOf(late)?.alpha).toBe(1);
                renderer.destroy();
            });

            it('is idempotent', async () => {
                const renderer = await ready();
                const root = renderer.createNode(sprite());
                const child = renderer.createNode(sprite({ parent: root }));

                renderer.updateSubtree(root, { alpha: 0.5 });
                renderer.updateSubtree(root, { alpha: 0.5 });
                // No float accumulation, because it sets rather than multiplies.
                expect(renderer.localTransformOf(child)?.alpha).toBe(0.5);
                renderer.destroy();
            });
        });

        // ─── surfaces ───────────────────────────────────────────────

        describe('surfaces (§4)', () => {
            it('reports which surfaces are enabled', async () => {
                const renderer = await ready();
                for (const surface of surfaces) {
                    expect(renderer.isSurfaceEnabled(surface)).toBe(true);
                }
                renderer.destroy();
            });

            it('throws when creating a node on a disabled surface', async () => {
                const renderer = makeRenderer();
                await renderer.init({
                    container: undefined as unknown as HTMLElement,
                    design: DESIGN,
                    enabledSurfaces: ['world', 'ui'],
                });

                expect(renderer.isSurfaceEnabled('editorOverlay')).toBe(false);
                expect(() =>
                    renderer.createNode({ kind: 'group', surface: 'editorOverlay' }),
                ).toThrow(RendererError);
                renderer.destroy();
            });

            it('leaves setSurfaceVisible on a disabled surface a silent no-op', async () => {
                const renderer = makeRenderer();
                await renderer.init({
                    container: undefined as unknown as HTMLElement,
                    design: DESIGN,
                    enabledSurfaces: ['world', 'ui'],
                });

                expect(() => renderer.setSurfaceVisible('editorUi', false)).not.toThrow();
                renderer.destroy();
            });

            it('reports a node surface, defaulting to world', async () => {
                const renderer = await ready();
                const implicit = renderer.createNode({ kind: 'sprite', texture: image.name });
                const ui = renderer.createNode({ kind: 'text', text: 'hi', surface: 'ui' });

                expect(renderer.surfaceOf(implicit)).toBe('world');
                expect(renderer.surfaceOf(ui)).toBe('ui');
                renderer.destroy();
            });

            it('rejects a text node on a camera-transformed surface (§9.3)', async () => {
                const renderer = await ready();
                // The error must point at createTextAsset — world text is an asset first.
                expect(() =>
                    renderer.createNode({ kind: 'text', text: 'boom', surface: 'world' }),
                ).toThrow(RendererError);
                expect(() =>
                    renderer.createNode({ kind: 'text', text: 'boom', surface: 'editorOverlay' }),
                ).toThrow(RendererError);
                // UI is fine.
                expect(() =>
                    renderer.createNode({ kind: 'text', text: 'ok', surface: 'ui' }),
                ).not.toThrow();
                renderer.destroy();
            });
        });

        // ─── camera and viewport ────────────────────────────────────

        describe('camera and viewport (§4.2, §6.4)', () => {
            it('reports the camera it was given, defaulting framing to stage', async () => {
                const renderer = await ready();
                renderer.setCamera({ position: { x: 10, y: -20 }, zoom: 2 });

                expect(renderer.camera.position.x).toBe(10);
                expect(renderer.camera.position.y).toBe(-20);
                expect(renderer.camera.zoom).toBe(2);
                expect(renderer.camera.framing ?? 'stage').toBe('stage');
                renderer.destroy();
            });

            it('does not retain the caller camera object', async () => {
                const renderer = await ready();
                const camera = { position: { x: 1, y: 2 }, zoom: 1 };
                renderer.setCamera(camera);
                camera.position.x = 999;
                expect(renderer.camera.position.x).toBe(1);
                renderer.destroy();
            });

            it('centers the viewport on the camera, y-up so top > bottom', async () => {
                const renderer = await ready();
                renderer.resize(DESIGN.width, DESIGN.height);
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

                const v = renderer.viewport;
                expect(v.top).toBeGreaterThan(v.bottom);
                expect(v.right).toBeGreaterThan(v.left);
                expect((v.left + v.right) / 2).toBeCloseTo(0, 9);
                expect((v.top + v.bottom) / 2).toBeCloseTo(0, 9);
                renderer.destroy();
            });

            it('follows the camera position', async () => {
                const renderer = await ready();
                renderer.resize(DESIGN.width, DESIGN.height);
                renderer.setCamera({ position: { x: 100, y: 50 }, zoom: 1 });

                const v = renderer.viewport;
                expect((v.left + v.right) / 2).toBeCloseTo(100, 9);
                expect((v.top + v.bottom) / 2).toBeCloseTo(50, 9);
                renderer.destroy();
            });

            it('halves the visible world when zoom doubles', async () => {
                const renderer = await ready();
                renderer.resize(DESIGN.width, DESIGN.height);

                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
                const wide = renderer.viewport.right - renderer.viewport.left;
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 2 });
                const close = renderer.viewport.right - renderer.viewport.left;

                expect(close).toBeCloseTo(wide / 2, 9);
                renderer.destroy();
            });

            it('gives the stage rect in screen space, bottom > top', async () => {
                const renderer = await ready();
                renderer.resize(1600, 900);
                const stage = renderer.stageRect;
                expect(stage.bottom).toBeGreaterThan(stage.top);
                expect(stage.right).toBeGreaterThan(stage.left);
                renderer.destroy();
            });

            it('reports a usable resolution', async () => {
                const renderer = await ready();
                expect(renderer.resolution).toBeGreaterThanOrEqual(1);
                renderer.destroy();
            });

            it('tracks canvasSize through resize', async () => {
                const renderer = await ready();
                renderer.resize(1024, 768);
                expect(renderer.canvasSize.width).toBe(1024);
                expect(renderer.canvasSize.height).toBe(768);
                renderer.destroy();
            });
        });

        describe('projection round-trips (§6.4)', () => {
            it('maps the world origin to the canvas center for a centered camera', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

                const screen = renderer.worldToScreen({ x: 0, y: 0 });
                expect(screen.x).toBeCloseTo(400, 9);
                expect(screen.y).toBeCloseTo(300, 9);
                renderer.destroy();
            });

            it('flips y — a point above the camera gets a smaller screen y (§6.3)', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });

                const above = renderer.worldToScreen({ x: 0, y: 100 });
                const below = renderer.worldToScreen({ x: 0, y: -100 });
                expect(above.y).toBeLessThan(below.y);
                renderer.destroy();
            });

            it('round-trips screenToWorld ∘ worldToScreen over several cameras', async () => {
                const renderer = await ready();
                renderer.resize(1600, 900);

                for (const camera of [
                    { position: { x: 0, y: 0 }, zoom: 1 },
                    { position: { x: 250, y: -75 }, zoom: 2 },
                    { position: { x: -33.5, y: 12.25 }, zoom: 0.5 },
                ]) {
                    renderer.setCamera(camera);
                    for (const point of [
                        { x: 0, y: 0 },
                        { x: 123.5, y: -456.25 },
                        { x: -1000, y: 1000 },
                    ]) {
                        const back = renderer.screenToWorld(renderer.worldToScreen(point));
                        expect(back.x).toBeCloseTo(point.x, 9);
                        expect(back.y).toBeCloseTo(point.y, 9);
                    }
                }
                renderer.destroy();
            });

            it('writes into the caller out parameter', async () => {
                const renderer = await ready();
                const out = { x: 0, y: 0, z: 0 };
                expect(renderer.worldToScreen({ x: 1, y: 1 }, out)).toBe(out);
                expect(renderer.screenToWorld({ x: 1, y: 1 }, out)).toBe(out);
                renderer.destroy();
            });

            it('projects a node screen position', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
                const id = renderer.createNode(sprite({ position: { x: 0, y: 0 } }));

                const screen = renderer.screenPositionOf(id);
                expect(screen?.x).toBeCloseTo(400, 9);
                expect(screen?.y).toBeCloseTo(300, 9);
                renderer.destroy();
            });

            it('anchors a UI node y-down from its anchor, in design px', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                const id = renderer.createNode({
                    kind: 'group',
                    surface: 'ui',
                    uiAnchor: 'top-left',
                    position: { x: 20, y: 20 },
                });

                const screen = renderer.screenPositionOf(id);
                expect(screen?.x).toBeCloseTo(20, 9);
                expect(screen?.y).toBeCloseTo(20, 9);
                renderer.destroy();
            });

            it('scales a UI offset by fitScale', async () => {
                const renderer = await ready();
                renderer.resize(1600, 1200);
                const id = renderer.createNode({
                    kind: 'group',
                    surface: 'ui',
                    uiAnchor: 'top-left',
                    position: { x: 20, y: 20 },
                });

                const screen = renderer.screenPositionOf(id);
                expect(screen?.x).toBeCloseTo(40, 9);
                expect(screen?.y).toBeCloseTo(40, 9);
                renderer.destroy();
            });

            it('anchors a UI child from its ROOT anchor, not its own', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                const parent = renderer.createNode({
                    kind: 'group',
                    surface: 'ui',
                    uiAnchor: 'bottom-right',
                    position: { x: -100, y: -50 },
                });
                const child = renderer.createNode({
                    kind: 'group',
                    surface: 'ui',
                    parent,
                    position: { x: 0, y: 0 },
                });

                // The child sits exactly on its parent, so it reports the same screen point: the
                // origin is contributed once, by the anchoring root.
                const at = renderer.screenPositionOf(parent);
                const on = renderer.screenPositionOf(child);
                expect(at?.x).toBeCloseTo(700, 9);
                expect(at?.y).toBeCloseTo(550, 9);
                expect(on?.x).toBeCloseTo(at?.x ?? 0, 9);
                expect(on?.y).toBeCloseTo(at?.y ?? 0, 9);
                renderer.destroy();
            });
        });

        // ─── bounds ─────────────────────────────────────────────────

        describe('bounds (§8)', () => {
            it('sizes a sprite from its texture, centered by default', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());

                const local = renderer.localBoundsOf(id);
                // anchor defaults to {0.5, 0.5}, so the rect straddles the origin.
                expect(local?.right).toBeCloseTo(image.size.width / 2, 9);
                expect(local?.left).toBeCloseTo(-image.size.width / 2, 9);
                expect(local?.top).toBeCloseTo(image.size.height / 2, 9);
                expect(local?.bottom).toBeCloseTo(-image.size.height / 2, 9);
                renderer.destroy();
            });

            it('gives a group zero extent', async () => {
                const renderer = await ready();
                const group = renderer.createNode({ kind: 'group', surface: 'world' });
                const local = renderer.localBoundsOf(group);
                expect(local?.left).toBe(0);
                expect(local?.right).toBe(0);
                expect(local?.top).toBe(0);
                expect(local?.bottom).toBe(0);
                renderer.destroy();
            });

            it('translates world bounds by the resolved position', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite({ position: { x: 100, y: 50 } }));

                const world = renderer.worldBoundsOf(id);
                expect((world!.left + world!.right) / 2).toBeCloseTo(100, 9);
                expect((world!.top + world!.bottom) / 2).toBeCloseTo(50, 9);
                // y-up.
                expect(world!.top).toBeGreaterThan(world!.bottom);
                renderer.destroy();
            });

            it('expands world bounds to the rotated AABB', async () => {
                const renderer = await ready();
                const straight = renderer.createNode(sprite());
                const turned = renderer.createNode(sprite({ rotation: 45 }));

                const a = renderer.worldBoundsOf(straight)!;
                const b = renderer.worldBoundsOf(turned)!;
                // A 45-degree turn must widen a non-square rect's AABB.
                expect(b.right - b.left).toBeGreaterThan(a.right - a.left);
                renderer.destroy();
            });

            it('scales local bounds per axis, staying normalized under a flip', async () => {
                const renderer = await ready();
                const flipped = renderer.createNode(sprite({ scale: { x: -1, y: 1 } }));

                const local = renderer.localBoundsOf(flipped)!;
                // A negative scale is the common horizontal flip (§5) and must not invert the
                // rect.
                expect(local.left).toBeLessThanOrEqual(local.right);
                expect(local.bottom).toBeLessThanOrEqual(local.top);
                expect(local.right - local.left).toBeCloseTo(image.size.width, 9);
                renderer.destroy();
            });

            it('gives screen bounds in screen space, bottom > top', async () => {
                const renderer = await ready();
                renderer.resize(800, 600);
                renderer.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
                const id = renderer.createNode(sprite());

                const screen = renderer.screenBoundsOf(id)!;
                expect(screen.bottom).toBeGreaterThan(screen.top);
                expect(screen.right).toBeGreaterThan(screen.left);
                renderer.destroy();
            });
        });

        // ─── assets ─────────────────────────────────────────────────

        describe('assets (§9)', () => {
            it('resolves a load with the name and a size', async () => {
                const renderer = await ready();
                expect(renderer.hasAsset(image.name)).toBe(true);
                expect(renderer.getAssetSize(image.name)).toEqual(image.size);
                renderer.destroy();
            });

            it('returns null for an unknown asset size', async () => {
                const renderer = await ready();
                expect(renderer.hasAsset('nope')).toBe(false);
                expect(renderer.getAssetSize('nope')).toBeNull();
                renderer.destroy();
            });

            it('reports a structurally invalid entry rather than loading it', async () => {
                const renderer = await ready();
                const result = await renderer.loadAssets([
                    { name: '', kind: 'image', url: '/a.png' },
                    { name: 'bad-url', kind: 'image', url: 'javascript:alert(1)' },
                    { name: 'no-url', kind: 'image', url: '' },
                    {
                        name: 'fine',
                        kind: 'image',
                        url: '/fine.png',
                        size: { width: 2, height: 2 },
                    },
                ]);

                // One bad line in a manifest must not cost the level its good ones.
                expect(result.failed.map((f) => f.name).toSorted()).toEqual([
                    '',
                    'bad-url',
                    'no-url',
                ]);
                expect(result.loaded.map((info) => info.name)).toEqual(['fine']);
                expect(renderer.hasAsset('bad-url')).toBe(false);
                renderer.destroy();
            });

            it('resolves loadAssets with a result rather than rejecting (§9.1)', async () => {
                const renderer = await ready();
                const result = await renderer.loadAssets([
                    { name: 'a', kind: 'image', url: '/a.png', size: { width: 8, height: 8 } },
                    { name: 'b', kind: 'image', url: '/b.png', size: { width: 4, height: 4 } },
                ]);

                expect(result.loaded.map((info) => info.name).toSorted()).toEqual(['a', 'b']);
                expect(result.failed).toEqual([]);
                expect(typeof result.queued).toBe('boolean');
                renderer.destroy();
            });

            it('reports an unknown unload rather than throwing (§9.2)', async () => {
                const renderer = await ready();
                const result = await renderer.unloadAssets(['never-loaded']);

                expect(result.unknown).toContain('never-loaded');
                expect(result.unloaded).not.toContain('never-loaded');
                renderer.destroy();
            });

            it('is idempotent on repeated unloads', async () => {
                const renderer = await ready();
                await renderer.loadAsset({
                    name: 'temp',
                    kind: 'image',
                    url: '/t.png',
                    size: { width: 2, height: 2 },
                });

                const first = await renderer.unloadAssets(['temp']);
                expect(first.unloaded).toContain('temp');
                const second = await renderer.unloadAssets(['temp']);
                expect(second.unknown).toContain('temp');
                expect(renderer.hasAsset('temp')).toBe(false);
                renderer.destroy();
            });

            it('unloads an in-use texture anyway and reports it (§9.2)', async () => {
                const renderer = await ready();
                renderer.createNode(sprite());
                renderer.createNode(sprite());

                const result = await renderer.unloadAssets([image.name]);
                const reported = result.inUse.find((entry) => entry.name === image.name);
                expect(reported?.nodeCount).toBe(2);
                // Unloaded anyway — a level transition genuinely wants to force it.
                expect(result.unloaded).toContain(image.name);
                renderer.destroy();
            });

            it('keeps node handles valid after their texture is unloaded', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());
                await renderer.unloadAssets([image.name]);
                // The node falls back to the placeholder; its id stays valid (§9.2).
                expect(renderer.isAlive(id)).toBe(true);
                renderer.destroy();
            });

            it('accepts a manifest entry as well as a name when unloading', async () => {
                const renderer = await ready();
                const entry = {
                    name: 'byentry',
                    kind: 'image',
                    url: '/e.png',
                    size: { width: 1, height: 1 },
                } as const;
                await renderer.loadAsset(entry);

                const result = await renderer.unloadAssets([entry]);
                expect(result.unloaded).toContain('byentry');
                renderer.destroy();
            });

            it('creates a text asset with a real measured size (§9.3)', async () => {
                const renderer = await ready();
                const info = await renderer.createTextAsset('greeting', 'hello');

                expect(info.name).toBe('greeting');
                expect(info.size.width).toBeGreaterThan(0);
                expect(info.size.height).toBeGreaterThan(0);
                expect(renderer.hasAsset('greeting')).toBe(true);
                renderer.destroy();
            });

            it('measures longer text as wider', async () => {
                const renderer = await ready();
                const short = await renderer.createTextAsset('s', 'hi');
                const long = await renderer.createTextAsset('l', 'hello there world');
                expect(long.size.width).toBeGreaterThan(short.size.width);
                renderer.destroy();
            });

            it('makes a world text asset usable as a sprite texture (§9.3)', async () => {
                const renderer = await ready();
                await renderer.createTextAsset('label', 'Score');
                const id = renderer.createNode({
                    kind: 'sprite',
                    texture: 'label',
                    surface: 'world',
                });

                // The documented path for world text, and culling is exact because it has a
                // texture size.
                expect(renderer.isAlive(id)).toBe(true);
                expect(renderer.localBoundsOf(id)!.right).toBeGreaterThan(0);
                renderer.destroy();
            });

            it('createNodeAsync resolves with the id and the size', async () => {
                const renderer = await ready();
                const result = await renderer.createNodeAsync(sprite());

                expect(renderer.isAlive(result.id)).toBe(true);
                expect(result.size).toEqual(image.size);
                renderer.destroy();
            });
        });

        // ─── text nodes ─────────────────────────────────────────────

        describe('UI text nodes', () => {
            it('sets text on a UI text node', async () => {
                const renderer = await ready();
                const id = renderer.createNode({ kind: 'text', text: 'a', surface: 'ui' });
                expect(() => renderer.setNodeText(id, 'b')).not.toThrow();
                expect(renderer.isAlive(id)).toBe(true);
                renderer.destroy();
            });

            it('ignores setNodeText on a sprite', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite());
                expect(() => renderer.setNodeText(id, 'nope')).not.toThrow();
                renderer.destroy();
            });
        });

        // ─── events ─────────────────────────────────────────────────

        describe('events', () => {
            it('emits resize with the canvas, stage, viewport and resolution', async () => {
                const renderer = await ready();
                const seen: unknown[] = [];
                renderer.on('resize', (e) => seen.push(e));

                renderer.resize(1024, 768);

                expect(seen).toHaveLength(1);
                const event = seen[0] as {
                    canvas: { width: number };
                    stage: unknown;
                    viewport: unknown;
                    resolution: number;
                };
                expect(event.canvas.width).toBe(1024);
                expect(event.stage).toBeDefined();
                expect(event.viewport).toBeDefined();
                expect(event.resolution).toBeGreaterThanOrEqual(1);
                renderer.destroy();
            });

            it('returns an unsubscribe function (api_spec.ts:264)', async () => {
                const renderer = await ready();
                let count = 0;
                const off = renderer.on('resize', () => {
                    count++;
                });

                renderer.resize(900, 700);
                expect(count).toBe(1);

                off();
                renderer.resize(910, 710);
                expect(count).toBe(1);
                renderer.destroy();
            });

            it('supports several listeners for one event', async () => {
                const renderer = await ready();
                let a = 0;
                let b = 0;
                renderer.on('resize', () => {
                    a++;
                });
                renderer.on('resize', () => {
                    b++;
                });

                renderer.resize(640, 480);
                expect(a).toBe(1);
                expect(b).toBe(1);
                renderer.destroy();
            });
        });

        // ─── render ─────────────────────────────────────────────────

        describe('render', () => {
            it('is safe to call repeatedly and takes no dt (§11.1)', async () => {
                const renderer = await ready();
                renderer.createNode(sprite());
                expect(() => {
                    renderer.render();
                    renderer.render();
                }).not.toThrow();
                renderer.destroy();
            });

            it('leaves queries answerable after a render', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 10, y: 0 } }));
                const child = renderer.createNode(sprite({ parent, position: { x: 5, y: 0 } }));

                renderer.render();
                expect(renderer.resolvedTransformOf(child)?.position.x).toBe(15);
                renderer.destroy();
            });

            it('reports contextState as one of the three states', async () => {
                const renderer = await ready();
                expect(['ok', 'lost', 'restoring']).toContain(renderer.contextState);
                expect(renderer.pendingAssetOps).toBeGreaterThanOrEqual(0);
                renderer.destroy();
            });
        });

        // ─── inspect (§11.2) ────────────────────────────────────────

        describe('inspect', () => {
            it('returns an empty snapshot before init rather than throwing', () => {
                // An inspector panel may mount before the renderer does; it must need no guard.
                const snapshot = makeRenderer().inspect();
                expect(snapshot.nodes.size).toBe(0);
                expect(snapshot.counts.nodes).toBe(0);
                expect(snapshot.surfaces).toEqual([]);
            });

            it('returns an empty snapshot after destroy', async () => {
                const renderer = await ready();
                renderer.createNode(sprite());
                renderer.destroy();
                expect(renderer.inspect().nodes.size).toBe(0);
            });

            it('lists every live node, keyed by id', async () => {
                const renderer = await ready();
                const a = renderer.createNode(sprite({ position: { x: 1, y: 2 } }));
                const b = renderer.createNode(sprite());

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.size).toBe(2);
                expect(snapshot.nodes.get(a)?.id).toBe(a);
                expect(snapshot.nodes.get(b)?.id).toBe(b);
                expect(snapshot.counts.nodes).toBe(2);
                renderer.destroy();
            });

            it('drops a destroyed node and its cascaded children', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const child = renderer.createNode(sprite({ parent }));
                expect(renderer.inspect().nodes.size).toBe(2);

                renderer.destroyNode(parent);
                const snapshot = renderer.inspect();
                expect(snapshot.nodes.size).toBe(0);
                expect(snapshot.nodes.has(child)).toBe(false);
                renderer.destroy();
            });

            it('reports hierarchy both ways, with NO_NODE for a root', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const child = renderer.createNode(sprite({ parent }));

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.get(parent)?.parent).toBe(NO_NODE);
                expect(snapshot.nodes.get(parent)?.children).toEqual([child]);
                expect(snapshot.nodes.get(child)?.parent).toBe(parent);
                expect(snapshot.nodes.get(child)?.children).toEqual([]);
                renderer.destroy();
            });

            it('lists surface roots in draw order, by layer then insertion', async () => {
                const renderer = await ready();
                const mid = renderer.createNode(sprite({ layer: 5 }));
                const low = renderer.createNode(sprite({ layer: 1 }));
                const high = renderer.createNode(sprite({ layer: 9 }));

                expect(renderer.inspect().roots.world).toEqual([low, mid, high]);
                renderer.destroy();
            });

            it('breaks a layer tie by insertion order', async () => {
                const renderer = await ready();
                const first = renderer.createNode(sprite({ layer: 3 }));
                const second = renderer.createNode(sprite({ layer: 3 }));

                expect(renderer.inspect().roots.world).toEqual([first, second]);
                renderer.destroy();
            });

            it('orders children by layer too, so the tree matches what draws on top', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite());
                const over = renderer.createNode(sprite({ parent, layer: 8 }));
                const under = renderer.createNode(sprite({ parent, layer: 2 }));

                expect(renderer.inspect().nodes.get(parent)?.children).toEqual([under, over]);
                renderer.destroy();
            });

            it('keys roots only for enabled surfaces', async () => {
                const renderer = await ready();
                const snapshot = renderer.inspect();
                for (const surface of surfaces) {
                    expect(snapshot.roots[surface]).toBeDefined();
                }
                // 'editorUi' is absent from the default contract surfaces.
                if (!surfaces.includes('editorUi')) {
                    expect(snapshot.roots.editorUi).toBeUndefined();
                }
                renderer.destroy();
            });

            it('filters to one surface when asked', async () => {
                const renderer = await ready();
                const world = renderer.createNode(sprite());
                const ui = renderer.createNode({ kind: 'group', surface: 'ui' });

                const snapshot = renderer.inspect({ surface: 'world' });
                expect(snapshot.nodes.has(world)).toBe(true);
                expect(snapshot.nodes.has(ui)).toBe(false);
                expect(snapshot.surfaces.map((s) => s.surface)).toEqual(['world']);
                renderer.destroy();
            });

            it('reports local and resolved transforms, differing only by inheritance', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 100, y: 50 } }));
                const child = renderer.createNode(
                    sprite({ parent, position: { x: 10, y: 5 }, rotation: 30 }),
                );

                const snapshot = renderer.inspect();
                const c = snapshot.nodes.get(child);
                expect(c?.local.position.x).toBe(10);
                expect(c?.resolved.position.x).toBe(110);
                expect(c?.resolved.position.y).toBe(55);
                // Rotation does NOT inherit, so local and resolved agree on it (§5).
                expect(c?.local.rotation).toBe(30);
                expect(c?.resolved.rotation).toBe(30);
                renderer.destroy();
            });

            it('gives each node its OWN bounds objects, not shared scratch', async () => {
                // The core computes bounds through a reused scratch rect. If a snapshot handed that
                // rect out instead of a copy, every node would alias it and report the LAST node's
                // extent — a 10x10 sprite claiming to be 200x200. Two differently sized textures
                // are what make that visible; equal-sized ones would pass either way.
                const renderer = await ready();
                await renderer.loadAsset({
                    name: 'big-block',
                    kind: 'image',
                    url: '/test/big-block.png',
                    size: { width: image.size.width * 4, height: image.size.height * 4 },
                });
                const small = renderer.createNode(sprite());
                const big = renderer.createNode(sprite({ texture: 'big-block' }));

                const snapshot = renderer.inspect();
                const smallBounds = snapshot.nodes.get(small)?.localBounds;
                const bigBounds = snapshot.nodes.get(big)?.localBounds;

                expect(smallBounds).not.toBeNull();
                expect(bigBounds).not.toBeNull();
                // Distinct objects, and distinct values.
                expect(smallBounds).not.toBe(bigBounds);
                expect(smallBounds).not.toEqual(bigBounds);
                expect(snapshot.nodes.get(small)?.worldBounds).not.toBe(
                    snapshot.nodes.get(big)?.worldBounds,
                );
                renderer.destroy();
            });

            it('gives each node its own transform objects', async () => {
                // Same aliasing risk as bounds: `localTransformOf(id)` with no `out` must allocate.
                const renderer = await ready();
                const a = renderer.createNode(sprite({ position: { x: 5, y: 0 } }));
                const b = renderer.createNode(sprite({ position: { x: 90, y: 0 } }));

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.get(a)?.local).not.toBe(snapshot.nodes.get(b)?.local);
                expect(snapshot.nodes.get(a)?.local.position.x).toBe(5);
                expect(snapshot.nodes.get(b)?.local.position.x).toBe(90);
                // `local` and `resolved` must not be the same object either.
                expect(snapshot.nodes.get(a)?.local).not.toBe(snapshot.nodes.get(a)?.resolved);
                renderer.destroy();
            });

            it('reports bounds for a sprite and null for a group', async () => {
                const renderer = await ready();
                const s = renderer.createNode(sprite());
                const g = renderer.createNode({ kind: 'group', surface: 'world' });

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.get(s)?.localBounds).not.toBeNull();
                expect(snapshot.nodes.get(s)?.worldBounds).not.toBeNull();
                // A group has no art, so no extent (§8).
                expect(snapshot.nodes.get(g)?.localBounds).toBeNull();
                renderer.destroy();
            });

            it('omits bounds entirely under skipBounds', async () => {
                const renderer = await ready();
                const s = renderer.createNode(sprite());

                const snapshot = renderer.inspect({ skipBounds: true });
                expect(snapshot.nodes.get(s)?.localBounds).toBeNull();
                expect(snapshot.nodes.get(s)?.worldBounds).toBeNull();
                // Hierarchy still present — that is the point of the flag.
                expect(snapshot.nodes.get(s)?.id).toBe(s);
                renderer.destroy();
            });

            it('flags a sprite whose texture is not resident', async () => {
                const renderer = await ready();
                const good = renderer.createNode(sprite());
                const bad = renderer.createNode(sprite({ texture: 'never-loaded' }));

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.get(good)?.missingTexture).toBe(false);
                expect(snapshot.nodes.get(bad)?.missingTexture).toBe(true);
                renderer.destroy();
            });

            it('reports cull state after a render, and counts it', async () => {
                const renderer = await ready();
                renderer.createNode(sprite({ position: { x: 0, y: 0 } }));
                // Far outside an 800x600 stage, so §8 culls it.
                renderer.createNode(sprite({ position: { x: 50_000, y: 0 } }));
                renderer.render();

                const snapshot = renderer.inspect();
                expect(snapshot.counts.culled).toBe(1);
                const culledIds = [...snapshot.nodes.values()].filter((n) => n.culled);
                expect(culledIds).toHaveLength(1);
                renderer.destroy();
            });

            it('carries the view: camera, canvas, viewport, stage, resolution', async () => {
                const renderer = await ready();
                renderer.setCamera({ position: { x: 25, y: -10 }, zoom: 2 });

                const snapshot = renderer.inspect();
                expect(snapshot.camera.position.x).toBe(25);
                expect(snapshot.camera.zoom).toBe(2);
                expect(snapshot.canvas).toEqual(renderer.canvasSize);
                expect(snapshot.viewport).toEqual(renderer.viewport);
                expect(snapshot.stageRect).toEqual(renderer.stageRect);
                expect(snapshot.resolution).toBe(renderer.resolution);
                expect(snapshot.contextState).toBe(renderer.contextState);
                renderer.destroy();
            });

            it('lists resident assets with their sizes', async () => {
                const renderer = await ready();
                const snapshot = renderer.inspect();
                const entry = snapshot.assets.find((a) => a.name === image.name);
                expect(entry).toBeDefined();
                expect(entry?.size).toEqual(image.size);
                expect(snapshot.counts.assets).toBe(snapshot.assets.length);
                renderer.destroy();
            });

            it('reports surface visibility', async () => {
                const renderer = await ready();
                renderer.setSurfaceVisible('world', false);

                const snapshot = renderer.inspect();
                const world = snapshot.surfaces.find((s) => s.surface === 'world');
                expect(world?.visible).toBe(false);
                renderer.destroy();
            });

            it('lists surfaces bottom to top', async () => {
                const renderer = await ready();
                const listed = renderer.inspect().surfaces.map((s) => s.surface);
                const expected = ['editorSpace', 'world', 'ui', 'editorOverlay', 'editorUi'].filter(
                    (s) => surfaces.includes(s as Surface),
                );
                expect(listed).toEqual(expected);
                renderer.destroy();
            });

            it('is a SNAPSHOT: mutating it cannot touch the scene, and it does not live-update', async () => {
                const renderer = await ready();
                const id = renderer.createNode(sprite({ position: { x: 1, y: 1 } }));
                const snapshot = renderer.inspect();
                const before = snapshot.nodes.get(id);

                // Mutate the snapshot, then move the real node.
                if (before !== undefined) before.local.position.x = 999;
                renderer.updateNodes([{ id, position: { x: 7, y: 7 } }]);

                // The renderer is unaffected by the snapshot write...
                expect(renderer.localTransformOf(id)?.position.x).toBe(7);
                // ...and the old snapshot did not follow the node.
                expect(snapshot.nodes.get(id)?.local.position.x).toBe(999);
                // A fresh call sees the new truth.
                expect(renderer.inspect().nodes.get(id)?.local.position.x).toBe(7);
                renderer.destroy();
            });

            it('reports kind, layer, texture and text per node', async () => {
                const renderer = await ready();
                const s = renderer.createNode(sprite({ layer: 4 }));
                const g = renderer.createNode({ kind: 'group', surface: 'world' });
                const t = renderer.createNode({
                    kind: 'text',
                    surface: 'ui',
                    text: 'hello',
                    uiAnchor: 'top-left',
                });

                const snapshot = renderer.inspect();
                expect(snapshot.nodes.get(s)?.kind).toBe('sprite');
                expect(snapshot.nodes.get(s)?.texture).toBe(image.name);
                expect(snapshot.nodes.get(s)?.layer).toBe(4);
                expect(snapshot.nodes.get(g)?.kind).toBe('group');
                expect(snapshot.nodes.get(g)?.texture).toBe('');
                expect(snapshot.nodes.get(t)?.kind).toBe('text');
                expect(snapshot.nodes.get(t)?.text).toBe('hello');
                expect(snapshot.nodes.get(t)?.uiAnchor).toBe('top-left');
                renderer.destroy();
            });

            it('agrees with the narrow queries it duplicates', async () => {
                const renderer = await ready();
                const parent = renderer.createNode(sprite({ position: { x: 3, y: 4 } }));
                const child = renderer.createNode(sprite({ parent, position: { x: 1, y: 1 } }));
                renderer.render();

                const snapshot = renderer.inspect();
                for (const id of [parent, child]) {
                    const node = snapshot.nodes.get(id);
                    expect(node?.resolved.position).toEqual(
                        renderer.resolvedTransformOf(id)?.position,
                    );
                    expect(node?.worldBounds).toEqual(renderer.worldBoundsOf(id));
                    expect(node?.parent).toBe(renderer.parentOf(id));
                    expect(node?.surface).toBe(renderer.surfaceOf(id));
                }
                renderer.destroy();
            });
        });
    });
}

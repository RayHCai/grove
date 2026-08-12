// Render: create/destroy follow the delta, one moving entity among a hundred produces a
// one-patch call, and a missing template draws a placeholder — all over the null renderer.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { createNullRenderer } from '@platform/renderer/null';
import { NO_NODE } from '@platform/renderer';
import type { IRenderer, NodePatch } from '@platform/renderer';
import type { NetId, StateEnvelope, WireStructuralOp } from '@platform/protocol';
import { RenderBridge } from '../src/bridge.js';
import { Mirror } from '../src/mirror.js';
import { entity, transformDiff, wireTransform } from './fake-server.js';

const BOUNDS = { left: -400, right: 400, top: 300, bottom: -300 };

function stateEnvelope(structural: WireStructuralOp[] = [], tick = 1): StateEnvelope {
    return { kind: 'state', tick, ackSeq: 0, structural, state: [] };
}

/**
 * The null renderer plus a record of every `updateNodes` batch, for the patch-count assertions.
 *
 * `init` is awaited rather than skipped: before it, the renderer's node store does not exist and
 * `createNode` returns `NO_NODE` silently — so an uninitialized harness would pass the delta tests for
 * the wrong reason and fail every assertion about what was drawn.
 */
async function harness(): Promise<{
    renderer: IRenderer;
    batches: NodePatch[][];
    mirror: Mirror;
    bridge: RenderBridge;
}> {
    const renderer = createNullRenderer();
    await renderer.init({ container: {} as never, design: { width: 800, height: 600 } });
    const batches: NodePatch[][] = [];
    const realUpdate = renderer.updateNodes.bind(renderer);
    renderer.updateNodes = (patches: readonly NodePatch[]): void => {
        batches.push([...patches]);
        realUpdate(patches);
    };
    const mirror = new Mirror({ simRate: 60, bounds: BOUNDS, regions: [] });
    const bridge = new RenderBridge(renderer, mirror.view());
    return { renderer, batches, mirror, bridge };
}

afterEach(() => clearRuntime());

describe('the handle map keys on the local EntityId', () => {
    it('creates a node per added entity and destroys it on removal', async () => {
        const { mirror, bridge, renderer } = await harness();
        const added = mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }]));
        bridge.reconcile(added);
        expect(bridge.nodeCount).toBe(1);
        const node = bridge.nodeFor(added.added[0]!)!;
        expect(renderer.isAlive(node)).toBe(true);

        const removed = mirror.applyState(stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }]));
        bridge.reconcile(removed);
        expect(bridge.nodeCount).toBe(0);
        expect(renderer.isAlive(node)).toBe(false);
    });

    it('consumes a batch IN ORDER: spawn then destroy creates then destroys exactly one node', async () => {
        // A set-union would create a node for a dead entity or destroy one never created.
        const { mirror, bridge } = await harness();
        const first = mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }], 1));
        const second = mirror.applyState(
            stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 2),
        );
        bridge.reconcile(first);
        expect(bridge.nodeCount).toBe(1);
        bridge.reconcile(second);
        expect(bridge.nodeCount).toBe(0);
    });

    it('cascades to children and leaves no stale map key', async () => {
        const { mirror, bridge, renderer } = await harness();
        const delta = mirror.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'parent') },
                { kind: 'spawn', snapshot: entity(2, 'child', { parent: 1 as NetId }) },
            ]),
        );
        bridge.reconcile(delta);
        const [parentLocal, childLocal] = delta.added as [never, never];
        const childNode = bridge.nodeFor(childLocal)!;
        expect(renderer.parentOf(childNode)).toBe(bridge.nodeFor(parentLocal));

        // Destroying the parent: core cascades the entity, the renderer cascades the node, and the
        // bridge must drop the child's map entry or a later spawn reusing that EntityId finds a stale
        // node.
        const removed = mirror.applyState(
            stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 2),
        );
        bridge.reconcile(removed);
        expect(renderer.isAlive(childNode)).toBe(false);
        expect(bridge.nodeFor(childLocal)).toBeUndefined();
        expect(bridge.nodeCount).toBe(0);
    });

    it('unmaps GRANDCHILDREN too, since destroyNode cascades the whole subtree', async () => {
        // A grandchild's parent is the child, not the destroyed node, so an immediate-parent test leaves
        // its entry behind — a stale node a later spawn reusing that EntityId would find.
        const { mirror, bridge, renderer } = await harness();
        const delta = mirror.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'root') },
                { kind: 'spawn', snapshot: entity(2, 'child', { parent: 1 as NetId }) },
                { kind: 'spawn', snapshot: entity(3, 'grandchild', { parent: 2 as NetId }) },
            ]),
        );
        bridge.reconcile(delta);
        expect(bridge.nodeCount).toBe(3);
        const grandchildNode = bridge.nodeFor(delta.added[2]!)!;

        const removed = mirror.applyState(
            stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 2),
        );
        bridge.reconcile(removed);
        expect(renderer.isAlive(grandchildNode)).toBe(false);
        expect(bridge.nodeCount).toBe(0);
    });

    it('follows a reparent into the render tree', async () => {
        // The mirror applies the op to core, but the node stays under its old parent unless the delta
        // carries the reparent: the wire's transform is local to the new parent, so a node left behind
        // renders at the wrong place with no other symptom.
        const { mirror, bridge, renderer } = await harness();
        bridge.reconcile(
            mirror.applyState(
                stateEnvelope([
                    { kind: 'spawn', snapshot: entity(1, 'a') },
                    { kind: 'spawn', snapshot: entity(2, 'b') },
                ]),
            ),
        );
        const aLocal = mirror.index.local(1 as NetId)!;
        const bLocal = mirror.index.local(2 as NetId)!;
        const bNode = bridge.nodeFor(bLocal)!;
        expect(renderer.parentOf(bNode)).toBe(NO_NODE);

        bridge.reconcile(
            mirror.applyState(
                stateEnvelope([{ kind: 'reparent', netId: 2 as NetId, parent: 1 as NetId }], 2),
            ),
        );
        expect(renderer.parentOf(bNode)).toBe(bridge.nodeFor(aLocal));

        bridge.reconcile(
            mirror.applyState(
                stateEnvelope([{ kind: 'reparent', netId: 2 as NetId, parent: null }], 3),
            ),
        );
        expect(renderer.parentOf(bNode)).toBe(NO_NODE);
    });

    it('unmaps a subtree the bridge learned about through a reparent, not a spawn', async () => {
        // The destroy sweep walks the bridge's own hierarchy rather than the renderer's, so a link made
        // after creation has to be recorded there too.
        const { mirror, bridge, renderer } = await harness();
        bridge.reconcile(
            mirror.applyState(
                stateEnvelope([
                    { kind: 'spawn', snapshot: entity(1, 'root') },
                    { kind: 'spawn', snapshot: entity(2, 'later-child') },
                ]),
            ),
        );
        bridge.reconcile(
            mirror.applyState(
                stateEnvelope([{ kind: 'reparent', netId: 2 as NetId, parent: 1 as NetId }], 2),
            ),
        );
        const childLocal = mirror.index.local(2 as NetId)!;
        const childNode = bridge.nodeFor(childLocal)!;

        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 3)),
        );
        expect(renderer.isAlive(childNode)).toBe(false);
        expect(bridge.nodeFor(childLocal)).toBeUndefined();
        expect(bridge.nodeCount).toBe(0);
    });

    it('spawns a node at the entity’s authored transform, not the origin', async () => {
        const { mirror, bridge, renderer } = await harness();
        const delta = mirror.applyState(
            stateEnvelope([
                {
                    kind: 'spawn',
                    snapshot: entity(1, 'wall', {
                        transform: wireTransform({ posX: 12, posY: 34, scale: 3, layer: 2 }),
                    }),
                },
            ]),
        );
        bridge.reconcile(delta);
        const t = renderer.localTransformOf(bridge.nodeFor(delta.added[0]!)!)!;
        expect(t.position.x).toBe(12);
        expect(t.position.y).toBe(34);
        expect(t.scale.x).toBe(3);
    });
});

describe('transforms come from the dirty set', () => {
    it('patches ONE node when one entity of a hundred moves', async () => {
        const { mirror, bridge, batches } = await harness();
        const spawns: WireStructuralOp[] = [];
        for (let i = 1; i <= 100; i++) spawns.push({ kind: 'spawn', snapshot: entity(i) });
        bridge.reconcile(mirror.applyState(stateEnvelope(spawns, 1)));

        // Drain the spawn-time dirt, then move exactly one.
        bridge.pushTransforms();
        batches.length = 0;
        mirror.applyState(stateEnvelope([], 2));
        mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(7, { posX: 5 })],
        });
        bridge.pushTransforms();

        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(1);
    });

    it('drains exactly once per frame — a second drain observes an empty set', async () => {
        const { mirror, bridge, batches } = await harness();
        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }])),
        );
        bridge.pushTransforms();
        batches.length = 0;
        bridge.pushTransforms();
        expect(batches).toHaveLength(0);
    });

    it('does not patch a dead node: an entity destroyed in the frame it moved', async () => {
        const { mirror, bridge, batches } = await harness();
        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }], 1)),
        );
        bridge.pushTransforms();
        batches.length = 0;

        // Moves and is destroyed in the same envelope, leaving its index dirty and its slot empty.
        mirror.applyState(stateEnvelope([], 2));
        mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 9 })],
        });
        const removed = mirror.applyState(
            stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 3),
        );
        bridge.reconcile(removed);
        expect(() => bridge.pushTransforms()).not.toThrow();
        expect(batches.flat()).toHaveLength(0);
    });

    it('pushes nothing when nothing moved', async () => {
        const { bridge, batches } = await harness();
        bridge.pushTransforms();
        expect(batches).toHaveLength(0);
    });
});

describe('the manifest and the template table', () => {
    it('draws a PLACEHOLDER for a missing template rather than skipping the entity', async () => {
        // An entity that exists in the simulation but not on screen is the harder bug to see.
        const { mirror, bridge, renderer } = await harness();
        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'unknown-template') }]),
        );
        bridge.reconcile(delta);
        const node = bridge.nodeFor(delta.added[0]!)!;
        expect(renderer.isAlive(node)).toBe(true);
        expect(renderer.inspect().nodes.get(node)?.missingTexture).toBe(true);
    });

    it('refuses an asset URL whose scheme the loader must not fetch', async () => {
        const { bridge, renderer } = await harness();
        await bridge.loadManifest({
            assets: [
                { key: 'js', kind: 'texture', url: 'javascript:alert(1)' },
                { key: 'data', kind: 'texture', url: 'data:image/png;base64,AAAA' },
                { key: 'file', kind: 'atlas', url: 'file:///etc/passwd' },
                // Lexical evasions the parse normalizes away before the check.
                { key: 'spaced', kind: 'texture', url: '  javascript:alert(1)' },
                { key: 'cased', kind: 'texture', url: 'JavaScript:alert(1)' },
                // The legitimate shapes: a relative path, and an absolute https one.
                { key: 'ok-rel', kind: 'texture', url: '/coin.png' },
                { key: 'ok-abs', kind: 'texture', url: 'https://cdn.example/coin.png' },
            ],
            templates: [],
        });

        const loaded = renderer.inspect().assets.map((a) => a.name);
        expect(loaded).toStrictEqual(['ok-rel', 'ok-abs']);
    });

    it('maps a sprite template’s visual onto the node desc', async () => {
        const { mirror, bridge, renderer } = await harness();
        await bridge.loadManifest({
            assets: [
                {
                    key: 'coin.png',
                    kind: 'texture',
                    url: '/coin.png',
                    meta: { width: 16, height: 16 },
                },
            ],
            templates: [{ template: 'coin', kind: 'sprite', texture: 'coin.png', tint: 0xff0000 }],
        });
        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'coin') }]),
        );
        bridge.reconcile(delta);
        const snapshot = renderer.inspect().nodes.get(bridge.nodeFor(delta.added[0]!)!)!;
        expect(snapshot.kind).toBe('sprite');
        expect(snapshot.texture).toBe('coin.png');
        expect(snapshot.missingTexture).toBe(false);
    });

    it('makes a group template a group node, with no art', async () => {
        const { mirror, bridge, renderer } = await harness();
        void bridge.loadManifest({ assets: [], templates: [{ template: 'pivot', kind: 'group' }] });
        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'pivot') }]),
        );
        bridge.reconcile(delta);
        expect(renderer.inspect().nodes.get(bridge.nodeFor(delta.added[0]!)!)?.kind).toBe('group');
    });

    it('skips non-renderer asset kinds rather than handing them to loadAssets', async () => {
        const { renderer, bridge } = await harness();
        const requested: string[] = [];
        renderer.loadAssets = async (entries): Promise<never> => {
            requested.push(...entries.map((e) => e.name));
            return { loaded: [], failed: [], queued: false } as never;
        };
        await bridge.loadManifest({
            assets: [
                { key: 'art', kind: 'texture', url: '/a.png' },
                { key: 'boom', kind: 'audio', url: '/b.mp3' },
                { key: 'walk', kind: 'clip', url: '/c.json' },
                { key: 'sheet', kind: 'atlas', url: '/d.json' },
            ],
            templates: [],
        });
        expect(requested.toSorted()).toEqual(['art', 'sheet']);
    });
});

describe('the camera is pushed every frame', () => {
    it('sets it unconditionally rather than on change', async () => {
        const { renderer, bridge } = await harness();
        let calls = 0;
        renderer.setCamera = (): void => {
            calls++;
        };
        bridge.pushCamera({ position: { x: 1, y: 2, z: 0 }, zoom: 2 });
        bridge.pushCamera({ position: { x: 1, y: 2, z: 0 }, zoom: 2 });
        expect(calls).toBe(2);
    });

    it('reports the renderer’s viewport extent, for the cursor quantum', async () => {
        const { bridge } = await harness();
        const v = bridge.viewport;
        expect(v.width).toBeGreaterThanOrEqual(0);
        expect(v.height).toBeGreaterThanOrEqual(0);
    });
});

describe('teardown', () => {
    it('destroys every node it created and empties the map', async () => {
        const { mirror, bridge, renderer } = await harness();
        const delta = mirror.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1) },
                { kind: 'spawn', snapshot: entity(2) },
            ]),
        );
        bridge.reconcile(delta);
        const nodes = delta.added.map((local) => bridge.nodeFor(local)!);
        bridge.clear();
        expect(bridge.nodeCount).toBe(0);
        for (const node of nodes) expect(renderer.isAlive(node)).toBe(false);
    });
});

// Render: create/destroy follow the delta, one moving entity among a hundred produces a
// one-patch call, and a missing template draws a placeholder — all over the null renderer.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import { createNullRenderer } from '@platform/renderer/null';
import { NO_NODE } from '@platform/renderer';
import type { IRenderer, NodeId, NodePatch } from '@platform/renderer';
import type {
    GroupTemplateVisual,
    NetId,
    StateEnvelope,
    TemplateChild,
    WireStructuralOp,
    WireTransform,
} from '@platform/protocol';
import type { EntityId } from '@platform/core';
import { RenderBridge } from '../src/bridge.js';
import { MAX_TEMPLATE_DEPTH, MAX_TEMPLATE_NODES } from '../src/constants.js';
import { Mirror } from '../src/mirror.js';
import { entity, transformDiff, wireTransform } from './fake-server.js';

const BOUNDS = { left: -400, right: 400, top: 300, bottom: -300 };
/** The package default, so the render delay under test is a round 50 ms. */
const SEND_RATE = 20;
const SEND_INTERVAL = 1 / SEND_RATE;

/** A nested group template: a base sprite, and a barrel one level down under its own pivot. */
const TURRET: GroupTemplateVisual = {
    template: 'turret',
    kind: 'group',
    children: [
        { kind: 'sprite', texture: 'base.png' },
        {
            kind: 'group',
            offsetY: 12,
            children: [{ kind: 'sprite', texture: 'barrel.png', offsetY: 6, rotation: 0 }],
        },
    ],
};

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
async function harness(sendRate = SEND_RATE): Promise<{
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
    const bridge = new RenderBridge(renderer, mirror.view(), sendRate);
    return { renderer, batches, mirror, bridge };
}

/** Spawns one entity and returns its local handle, which is what the buffer keys on. */
function spawn(mirror: Mirror, bridge: RenderBridge, netId = 1): EntityId {
    const delta = mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(netId) }], 1));
    bridge.reconcile(delta);
    return delta.added[0]!;
}

/** One send: the tick's state envelope, then the transform it joins on — the wire's own order. */
function move(mirror: Mirror, netId: number, tick: number, over: Partial<WireTransform>): void {
    mirror.applyState(stateEnvelope([], tick));
    mirror.applyTransforms({ kind: 'transform', tick, transform: [transformDiff(netId, over)] });
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
        bridge.pushTransforms(0);
        batches.length = 0;
        mirror.applyState(stateEnvelope([], 2));
        mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(7, { posX: 5 })],
        });
        bridge.pushTransforms(0);

        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(1);
    });

    it('drains exactly once per frame — a second drain observes an empty set', async () => {
        const { mirror, bridge, batches } = await harness();
        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }])),
        );
        bridge.pushTransforms(0);
        batches.length = 0;
        bridge.pushTransforms(0);
        expect(batches).toHaveLength(0);
    });

    it('does not patch a dead node: an entity destroyed in the frame it moved', async () => {
        const { mirror, bridge, batches } = await harness();
        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }], 1)),
        );
        bridge.pushTransforms(0);
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
        expect(() => bridge.pushTransforms(0)).not.toThrow();
        expect(batches.flat()).toHaveLength(0);
    });

    it('pushes nothing when nothing moved', async () => {
        const { bridge, batches } = await harness();
        bridge.pushTransforms(0);
        expect(batches).toHaveLength(0);
    });
});

describe('the interpolation buffer sits between the send rate and the frame rate', () => {
    it('walks an entity between the two poses the wire sent, rather than holding the last one', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;

        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);

        // The drawn moment trails the newest sample by one send interval, so this frame is still on
        // the older pose and the one halfway between the samples draws halfway between the poses.
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(0, 6);
        bridge.pushTransforms(SEND_INTERVAL * 1.5);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(50, 6);

        // And it lands exactly on what the authority said, not a fraction short of it.
        bridge.pushTransforms(SEND_INTERVAL * 2);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(100, 6);
    });

    it('patches on the frames between two envelopes — which is the whole point of it', async () => {
        const { mirror, bridge, renderer, batches } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);
        batches.length = 0;

        // Nothing on the wire for either frame; without the buffer both would be no-ops and the node
        // would hold its pose until the next envelope.
        bridge.pushTransforms(SEND_INTERVAL * 1.25);
        const quarter = renderer.localTransformOf(node)!.position.x;
        bridge.pushTransforms(SEND_INTERVAL * 1.75);
        const threeQuarters = renderer.localTransformOf(node)!.position.x;

        expect(batches).toHaveLength(2);
        expect(quarter).toBeGreaterThan(0);
        expect(threeQuarters).toBeGreaterThan(quarter);
    });

    it('stops patching once the drawn pose has caught up, so a static world stays free', async () => {
        const { mirror, bridge, batches } = await harness();
        spawn(mirror, bridge);
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);
        bridge.pushTransforms(SEND_INTERVAL * 2);
        batches.length = 0;

        bridge.pushTransforms(SEND_INTERVAL * 3);
        expect(batches).toHaveLength(0);
    });

    it('leaves a predicted entity alone: two smoothers on one entity rubber-band', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.setPredicted(new Set([local]));

        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);

        // No delay and no blend — what prediction owns is drawn where the simulation put it, and the
        // correction it already eases is the only thing allowed to move that pose.
        expect(renderer.localTransformOf(node)!.position.x).toBe(100);
        bridge.pushTransforms(SEND_INTERVAL * 1.5);
        expect(renderer.localTransformOf(node)!.position.x).toBe(100);
    });

    it('holds at the newest pose the wire sent rather than extrapolating past it', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);

        // Two intervals with nothing arriving. Carrying the last segment's velocity on would draw the
        // entity at 200 and take it back the moment the authority disagreed.
        bridge.pushTransforms(SEND_INTERVAL * 3);
        expect(renderer.localTransformOf(node)!.position.x).toBe(100);
    });

    it('opens a segment at the drawn moment, not at a sample the drawn pose already passed', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);
        // A second of standstill — an entity that stopped and an entity nobody sent for look the same.
        bridge.pushTransforms(1);
        expect(renderer.localTransformOf(node)!.position.x).toBe(100);

        move(mirror, 1, 3, { posX: 200 });
        bridge.pushTransforms(1 + SEND_INTERVAL);

        // Still where it was drawn. Dated from the older sample the segment would be a second long and
        // 95% spent, jumping the entity almost the whole way on this one frame.
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(100, 6);
        bridge.pushTransforms(1 + SEND_INTERVAL * 1.5);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(150, 6);
    });

    it('reads its delay from the rate `Welcome` named', async () => {
        const { mirror, bridge, renderer } = await harness(10);
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });

        // 0.1 s is one interval at 10 Hz, so the drawn moment is still the first sample. The same frame
        // on a 20 Hz session would be at the end of the segment.
        bridge.pushTransforms(0.1);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(0, 6);
        bridge.pushTransforms(0.15);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(50, 6);
    });

    it('spins a wrapped rotation the short way round', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { rot: 350 });
        bridge.pushTransforms(SEND_INTERVAL);
        move(mirror, 1, 3, { rot: 10 });
        bridge.pushTransforms(SEND_INTERVAL * 2);

        // Halfway from 350° to 10° is 360°, which is 0. Lerping the raw numbers draws 180 — the leaf
        // spinning backwards through half a turn, once per revolution.
        bridge.pushTransforms(SEND_INTERVAL * 2.5);
        expect(renderer.localTransformOf(node)!.rotation).toBeCloseTo(360, 6);
    });

    it('takes the newer layer whole: a fraction of a draw order is not a draw order', async () => {
        const { mirror, bridge, renderer } = await harness();
        const local = spawn(mirror, bridge);
        const node = bridge.nodeFor(local)!;
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100, layer: 5 });
        bridge.pushTransforms(SEND_INTERVAL);

        bridge.pushTransforms(SEND_INTERVAL * 1.5);
        expect(renderer.localTransformOf(node)!.position.x).toBeCloseTo(50, 6);
        expect(renderer.inspect().nodes.get(node)?.layer).toBe(5);
    });

    it('follows the drawn pose for the camera, not the simulated one', async () => {
        const { mirror, bridge } = await harness();
        const local = spawn(mirror, bridge);
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);
        bridge.pushTransforms(SEND_INTERVAL * 1.5);

        // A camera on the exact answer while the sprite is halfway to it slides the target across the
        // screen by a whole send interval of motion.
        expect(mirror.runtime.transforms.posX(local)).toBe(100);
        expect(bridge.drawnPosition(local).x).toBeCloseTo(50, 6);
    });

    it('drops the buffer on a resync: a segment across one interpolates between two worlds', async () => {
        const { mirror, bridge } = await harness();
        const local = spawn(mirror, bridge);
        bridge.pushTransforms(0);
        move(mirror, 1, 2, { posX: 100 });
        bridge.pushTransforms(SEND_INTERVAL);
        expect(bridge.drawnPosition(local).x).toBeCloseTo(0, 6);

        bridge.clear();

        // The stamps belong to a session that has ended: nothing survives to interpolate from, so the
        // pose is the simulation's again.
        expect(bridge.drawnPosition(local).x).toBe(100);
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
                { key: 'newline', kind: 'texture', url: 'java\nscript:alert(1)' },
                // Ours to construct, never the server's to name.
                { key: 'blob', kind: 'texture', url: 'blob:http://localhost/8f3c-1' },
                // The legitimate shapes: a relative path, and an absolute https one.
                { key: 'ok-rel', kind: 'texture', url: '/coin.png' },
                { key: 'ok-abs', kind: 'texture', url: 'https://cdn.example/coin.png' },
            ],
            templates: [],
        });

        const loaded = renderer.inspect().assets.map((a) => a.name);
        expect(loaded).toStrictEqual(['ok-rel', 'ok-abs']);
    });

    it('drops a manifest row with no url rather than letting the loader throw on it', async () => {
        const { bridge, renderer } = await harness();
        // Untyped wire data: an empty url resolves against the base and would pass a scheme test, but
        // `loadAssets` refuses it by throwing, which would take the rest of the manifest with it.
        await bridge.loadManifest({
            assets: [
                { key: 'blank', kind: 'texture', url: '' },
                { key: 'absent', kind: 'atlas', url: undefined as unknown as string },
                { key: 'ok', kind: 'texture', url: '/coin.png' },
            ],
            templates: [],
        });

        expect(renderer.inspect().assets.map((a) => a.name)).toStrictEqual(['ok']);
    });

    it('merges a later manifest in rather than replacing what the join established', async () => {
        const { mirror, bridge, renderer } = await harness();
        await bridge.loadManifest({
            assets: [{ key: 'coin.png', kind: 'texture', url: '/coin.png' }],
            templates: [{ template: 'coin', kind: 'sprite', texture: 'coin.png' }],
        });

        // What a mid-session `manifest` envelope carries: the additions alone.
        await bridge.loadManifest({
            assets: [{ key: 'gem.png', kind: 'texture', url: '/gem.png' }],
            templates: [{ template: 'gem', kind: 'sprite', texture: 'gem.png' }],
        });

        expect(
            renderer
                .inspect()
                .assets.map((a) => a.name)
                .toSorted(),
        ).toStrictEqual(['coin.png', 'gem.png']);

        // The template the JOIN established still resolves: a replacing load would have dropped it
        // and every coin on screen would have gone to the placeholder.
        const delta = mirror.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'coin') },
                { kind: 'spawn', snapshot: entity(2, 'gem') },
            ]),
        );
        bridge.reconcile(delta);
        const nodes = renderer.inspect().nodes;
        expect(nodes.get(bridge.nodeFor(delta.added[0]!)!)?.missingTexture).toBe(false);
        expect(nodes.get(bridge.nodeFor(delta.added[1]!)!)?.missingTexture).toBe(false);
    });

    it('does not re-fetch an asset it has already declared', async () => {
        const { bridge, renderer } = await harness();
        const manifest = {
            assets: [{ key: 'coin.png', kind: 'texture' as const, url: '/coin.png' }],
            templates: [],
        };
        await bridge.loadManifest(manifest);
        await bridge.loadManifest(manifest);
        // One entry, not two: the renderer's own intent map is what answers "already declared".
        expect(renderer.inspect().assets.map((a) => a.name)).toStrictEqual(['coin.png']);
    });

    it('resolves a template declared mid-session on the spawn riding right behind it', () => {
        // The trap the join path already documents, in its additive form: the template loop has to
        // fill before the first `await`, or the entity spawned in the very next envelope draws as a
        // placeholder and keeps it.
        return harness().then(({ mirror, bridge, renderer }) => {
            void bridge.loadManifest({
                assets: [],
                templates: [{ template: 'late', kind: 'group' }],
            });
            const delta = mirror.applyState(
                stateEnvelope([{ kind: 'spawn', snapshot: entity(9, 'late') }]),
            );
            bridge.reconcile(delta);
            expect(renderer.inspect().nodes.get(bridge.nodeFor(delta.added[0]!)!)?.kind).toBe(
                'group',
            );
        });
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

    it('builds a group template’s whole subtree in ONE renderer call', async () => {
        const { mirror, bridge, renderer } = await harness();
        let calls = 0;
        const realCreate = renderer.createSubtree.bind(renderer);
        renderer.createSubtree = (descs, out): NodeId[] => {
            calls++;
            return realCreate(descs, out);
        };
        await bridge.loadManifest({ assets: [], templates: [TURRET] });

        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'turret') }]),
        );
        bridge.reconcile(delta);

        const root = bridge.nodeFor(delta.added[0]!)!;
        const scene = renderer.inspect();
        // Root, base, the nested pivot and the barrel under it.
        expect(scene.counts.nodes).toBe(4);
        expect(calls).toBe(1);
        const [base, pivot] = scene.nodes.get(root)!.children;
        expect(scene.nodes.get(base!)?.texture).toBe('base.png');
        expect(scene.nodes.get(scene.nodes.get(pivot!)!.children[0]!)?.texture).toBe('barrel.png');
    });

    it('destroys every descendant with the entity, leaving the map empty', async () => {
        const { mirror, bridge, renderer } = await harness();
        await bridge.loadManifest({ assets: [], templates: [TURRET] });
        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'turret') }])),
        );
        expect(renderer.inspect().counts.nodes).toBe(4);

        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'destroy', netId: 1 as NetId }], 2)),
        );
        expect(bridge.nodeCount).toBe(0);
        expect(renderer.inspect().counts.nodes).toBe(0);
    });

    it('moves the subtree with the entity, and rotates only the node that spins', async () => {
        // Position and visibility are the only inherited channels, which is what makes a badge ride
        // upright over a parent that tumbles.
        const { mirror, bridge, renderer } = await harness();
        await bridge.loadManifest({ assets: [], templates: [TURRET] });
        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'turret') }]),
        );
        bridge.reconcile(delta);
        const root = bridge.nodeFor(delta.added[0]!)!;
        const barrel = renderer
            .inspect()
            .nodes.get(renderer.inspect().nodes.get(root)!.children[1]!)!.children[0]!;

        bridge.pushTransforms(0);
        mirror.applyState(stateEnvelope([], 2));
        mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: 200, posY: 50, rot: 90 })],
        });
        // Two intervals on, the drawn moment has reached the newest sample exactly.
        bridge.pushTransforms(SEND_INTERVAL);
        bridge.pushTransforms(SEND_INTERVAL * 2);

        const resolved = renderer.resolvedTransformOf(barrel)!;
        // 12 up for the pivot, 6 more for the barrel: the offsets composed onto the entity's move.
        expect(resolved.position.x).toBeCloseTo(200, 6);
        expect(resolved.position.y).toBeCloseTo(68, 6);
        expect(resolved.rotation).toBe(0);
        expect(renderer.localTransformOf(root)?.rotation).toBeCloseTo(90, 6);
    });

    it('culls a descendant that leaves the viewport while its parent is still inside', async () => {
        const { mirror, bridge, renderer } = await harness();
        await bridge.loadManifest({
            assets: [],
            templates: [
                {
                    template: 'banner',
                    kind: 'group',
                    // Far enough out that the child clears the viewport and the cull margin.
                    children: [{ kind: 'sprite', texture: 'far.png', offsetX: 5000 }],
                },
            ],
        });
        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'banner') }]),
        );
        bridge.reconcile(delta);
        bridge.pushTransforms(0);
        renderer.render();

        const root = bridge.nodeFor(delta.added[0]!)!;
        const child = renderer.inspect().nodes.get(root)!.children[0]!;
        expect(renderer.inspect().nodes.get(child)?.culled).toBe(true);

        // Sliding the parent back brings the child in: the cull pass reaches a node the bridge never
        // patched, through the resolved-changed set.
        mirror.applyState(stateEnvelope([], 2));
        mirror.applyTransforms({
            kind: 'transform',
            tick: 2,
            transform: [transformDiff(1, { posX: -5000 })],
        });
        bridge.pushTransforms(SEND_INTERVAL);
        bridge.pushTransforms(SEND_INTERVAL * 2);
        renderer.render();
        expect(renderer.inspect().nodes.get(child)?.culled).toBe(false);
    });

    it('refuses a child list past the depth bound, drawing the placeholder instead', async () => {
        // Recursive, so a per-level cardinality cap bounds nothing: the receiver bounds depth too, and
        // refuses the whole template rather than half-drawing it.
        const { mirror, bridge, renderer } = await harness();
        let deep: TemplateChild = { kind: 'sprite', texture: 'tip.png' };
        for (let i = 0; i < MAX_TEMPLATE_DEPTH + 1; i++) {
            deep = { kind: 'group', children: [deep] };
        }
        await bridge.loadManifest({
            assets: [],
            templates: [{ template: 'deep', kind: 'group', children: [deep] }],
        });

        const delta = mirror.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'deep') }]),
        );
        bridge.reconcile(delta);
        const node = bridge.nodeFor(delta.added[0]!)!;
        expect(renderer.inspect().counts.nodes).toBe(1);
        expect(renderer.inspect().nodes.get(node)?.missingTexture).toBe(true);
    });

    it('refuses a child list past the node bound', async () => {
        const { bridge, mirror, renderer } = await harness();
        const wide: TemplateChild[] = [];
        for (let i = 0; i <= MAX_TEMPLATE_NODES; i++)
            wide.push({ kind: 'sprite', texture: 'x.png' });
        await bridge.loadManifest({
            assets: [],
            templates: [{ template: 'wide', kind: 'group', children: wide }],
        });

        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'wide') }])),
        );
        expect(renderer.inspect().counts.nodes).toBe(1);
    });

    it('counts a sibling’s descendants toward the node bound, not just its own level', async () => {
        // Every level here passes its own entry check, because a nested sibling's subtree lands
        // BETWEEN this level's pushes; only a running total catches the overshoot.
        const { bridge, mirror, renderer } = await harness();
        const packed: TemplateChild[] = [];
        // Root plus this group fills the batch to the cap, so its two siblings have nowhere to go.
        for (let i = 0; i < MAX_TEMPLATE_NODES - 2; i++) {
            packed.push({ kind: 'sprite', texture: 'x.png' });
        }
        await bridge.loadManifest({
            assets: [],
            templates: [
                {
                    template: 'packed',
                    kind: 'group',
                    children: [
                        { kind: 'group', children: packed },
                        { kind: 'sprite', texture: 'x.png' },
                        { kind: 'sprite', texture: 'x.png' },
                    ],
                },
            ],
        });

        bridge.reconcile(
            mirror.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'packed') }])),
        );
        expect(renderer.inspect().counts.nodes).toBe(1);
    });

    it('refuses a malformed child rather than letting the renderer throw out of the frame', async () => {
        // A sprite with no texture is a caller bug to the renderer, and it throws — from inside a
        // spawn that would unwind the frame and end the session as a hostile peer.
        const { bridge, mirror, renderer } = await harness();
        await bridge.loadManifest({
            assets: [],
            templates: [
                {
                    template: 'broken',
                    kind: 'group',
                    children: [
                        { kind: 'sprite', texture: 'ok.png' },
                        { kind: 'sprite', texture: '' },
                    ],
                },
            ],
        });

        expect(() =>
            bridge.reconcile(
                mirror.applyState(
                    stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'broken') }]),
                ),
            ),
        ).not.toThrow();
        expect(renderer.inspect().counts.nodes).toBe(1);
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

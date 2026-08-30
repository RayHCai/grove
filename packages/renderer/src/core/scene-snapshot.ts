// The dev-tooling projection of a live scene: plain objects, allocated per node, reading only
// what `RendererCore` exposes. Separate from the core so that nothing in the frame path can come
// to depend on it.

import type { Bounds, Size } from '@platform/math';
import { bounds, boundsCopy, vec3 } from '@platform/math';
import type {
    ContextState,
    InspectOptions,
    NodeSnapshot,
    SceneSnapshot,
    Surface,
    Transform,
} from '../renderer.js';
import type { NodeId } from '../node-id.js';
import { NO_NODE } from '../node-id.js';
import { surfaceOrder } from '../surfaces.js';
import type { RendererCore } from './renderer-core.js';

/** A zeroed `Transform`, for the `out`-less call path. */
export function blankTransform(): Transform {
    return {
        position: vec3(),
        rotation: 0,
        scale: vec3(1, 1, 1),
        alpha: 1,
        visible: true,
    };
}

/**
 * Slots as ids, ordered by `layer` with ties broken by their position in `slots`.
 *
 * One rule for roots and for a node's children alike: a tree view that ordered the two
 * differently would misrepresent what draws on top. A slot with no record is dropped, because
 * the sibling walk behind a child list is not itself checked for liveness.
 */
export function inDrawOrder(core: RendererCore, slots: readonly number[]): NodeId[] {
    return (
        slots
            .map((slot, insertion) => ({
                slot,
                insertion,
                layer: core.nodes.recordAt(slot)?.layer ?? 0,
            }))
            // `toSorted` is stable, so equal layers keep insertion order.
            .toSorted((a, b) => a.layer - b.layer || a.insertion - b.insertion)
            .map((entry) => core.nodes.idAt(entry.slot))
            .filter((id) => id !== NO_NODE)
    );
}

/**
 * The scene as a plain snapshot, for tooling.
 *
 * Allocates per node deliberately: a debugger reading a live view of the SoA stores would see
 * values change under it mid-walk and could mutate the scene through a leaked reference.
 * `assets`, `contextState` and `surfaceVisible` arrive as arguments because residency, the GPU
 * context and surface visibility are the things the core does not own.
 */
export function snapshotScene(
    core: RendererCore,
    opts: InspectOptions | undefined,
    assets: ReadonlyArray<{ name: string; size: Size }>,
    contextState: ContextState,
    surfaceVisible: (surface: Surface) => boolean,
): SceneSnapshot {
    // Once up front, since re-resolving per node would be quadratic on a deep tree.
    core.xf.resolve();

    const resident = new Set(assets.map((asset) => asset.name));
    const wanted = opts?.surface;
    const skipBounds = opts?.skipBounds ?? false;

    // Local scratch, so a bounds read here cannot alias one the frame path is holding.
    const scratchLocal: Bounds = bounds();
    const scratchWorld: Bounds = bounds();

    const surfaces = core.config.enabledSurfaces
        .filter((surface) => wanted === undefined || surface === wanted)
        .toSorted((a, b) => surfaceOrder(a) - surfaceOrder(b))
        .map((surface) => ({ surface, visible: surfaceVisible(surface) }));

    const roots: Partial<Record<Surface, NodeId[]>> = {};
    for (const { surface } of surfaces) roots[surface] = core.drawOrderOf(surface);

    const nodes = new Map<NodeId, NodeSnapshot>();
    let culled = 0;
    for (const slot of core.nodes.liveIndices()) {
        const record = core.nodes.recordAt(slot);
        if (record === null) continue;
        if (wanted !== undefined && record.surface !== wanted) continue;

        const id = core.nodes.idAt(slot);
        if (id === NO_NODE) continue;

        const isCulled = core.xf.culled(slot);
        if (isCulled) culled++;

        // A group has no art, so it has no extent to report.
        const hasBounds = !skipBounds && record.kind !== 'group';

        nodes.set(id, {
            id,
            kind: record.kind,
            surface: record.surface,
            layer: record.layer,
            texture: record.texture,
            text: record.text,
            uiAnchor: record.uiAnchor,
            parent: core.parentOf(id),
            children: inDrawOrder(core, core.xf.children(slot)),
            local: core.localTransformOf(id) ?? blankTransform(),
            resolved: core.resolvedTransformOf(id) ?? blankTransform(),
            localBounds: hasBounds
                ? boundsCopy(bounds(), core.localBoundsAt(slot, scratchLocal))
                : null,
            worldBounds: hasBounds
                ? boundsCopy(bounds(), core.worldBoundsAt(slot, scratchWorld))
                : null,
            culled: isCulled,
            // Only a sprite can miss a texture: a group has none, and text carries its string.
            missingTexture: record.kind === 'sprite' && !resident.has(record.texture),
        });
    }

    return {
        roots,
        nodes,
        surfaces,
        camera: {
            position: { ...core.camera.position },
            zoom: core.camera.zoom,
            framing: core.camera.framing ?? 'stage',
        },
        canvas: { ...core.canvasSize },
        stageRect: boundsCopy(bounds(), core.stageRect),
        viewport: boundsCopy(bounds(), core.viewport),
        resolution: core.resolution,
        contextState,
        assets: assets.map((asset) => ({ name: asset.name, size: { ...asset.size } })),
        counts: {
            nodes: nodes.size,
            culled,
            surfaces: surfaces.length,
            assets: assets.length,
        },
    };
}

/**
 * The snapshot for a renderer that is not live — before `init`, after `destroy`.
 *
 * So `inspect()` never returns `null` and an inspector panel mounting before init reads zero nodes
 * rather than crashing.
 */
export function emptySnapshot(contextState: ContextState): SceneSnapshot {
    return {
        roots: {},
        nodes: new Map(),
        surfaces: [],
        camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' },
        canvas: { width: 0, height: 0 },
        stageRect: bounds(),
        viewport: bounds(),
        resolution: 1,
        contextState,
        assets: [],
        counts: { nodes: 0, culled: 0, surfaces: 0, assets: 0 },
    };
}

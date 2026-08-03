// The per-frame pass: dirty store -> local writes + cull toggles (§6.2, §6.3, §8).
//
// ONLY LOCAL VALUES ARE WRITTEN. The Pixi tree is nested and composes for us, so moving a parent
// writes the PARENT's local position and nothing else — the children's locals did not change.
// That is why `consumeFlushDirty` yields one node for a position write even though the resolved
// positions of a whole subtree moved (§6.1, §6.2).
//
// The y-flip is arithmetic here, at the write boundary, and nowhere else (§6.3).
//
// Culling is a FLAT SCAN over the store's typed arrays rather than a tree walk. That is possible
// only because rotation and scale do not inherit, so a node's AABB is a function of its own values
// plus its resolved position — no ancestor walk (§8).

import type { Bounds, Size } from '@platform/math';
import { bounds } from '@platform/math';
import type { Surface } from '../renderer.js';
import type { NodeStore } from '../node-store.js';
import type { TransformStore } from '../transform-store.js';
import { isCameraTransformed } from '../surfaces.js';
import { flipY, pixiRotation } from '../projection.js';
import { emptyLocalBounds, isVisibleInViewport, spriteLocalBounds, worldAabb } from '../bounds.js';
import type { NodeObjects } from './node-tree.js';
import { setArtRenderable } from './node-tree.js';

/** What `flush` needs to reach the display objects and the sizes behind them. */
export interface FlushContext {
    nodes: NodeStore;
    xf: TransformStore;
    /** The display-object pair for a slot, or `undefined` when it has none yet. */
    objectsAt: (index: number) => NodeObjects | undefined;
    /** The texture size behind a node, for its local bounds. */
    sizeAt: (index: number) => Size;
    /** World-space viewport, y-up. */
    viewport: Readonly<Bounds>;
    /** WORLD px of slack (§8). */
    cullMargin: number;
    /** Surface visibility, so a hidden surface skips the cull arithmetic entirely. */
    surfaceVisible: (surface: Surface) => boolean;
}

/** Reusable scratch: the steady-state path must not allocate. */
const scratchLocal: Bounds = bounds();
const scratchWorld: Bounds = bounds();
const dirtyOut: number[] = [];

/**
 * Resolves the store, writes every dirtied node's local values into Pixi, then updates cull flags.
 */
export function flush(ctx: FlushContext): void {
    ctx.xf.resolve();
    writeDirty(ctx);
    updateCulling(ctx);
}

/** Pushes each flush-dirty node's LOCAL values into its xform/art pair. */
function writeDirty(ctx: FlushContext): void {
    for (const index of ctx.xf.consumeFlushDirty(dirtyOut)) {
        const objects = ctx.objectsAt(index);
        if (objects === undefined) continue;
        writeNode(ctx, index, objects);
    }
}

/**
 * Writes one node.
 *
 * The split is exactly §6.2's: `xform` takes what inherits (position, visibility), `art` takes
 * what does not (scale, rotation, alpha, tint, anchor).
 */
function writeNode(ctx: FlushContext, index: number, objects: NodeObjects): void {
    const xf = ctx.xf;

    // The y-flip, at the write boundary. `flipY` rather than an open-coded minus, so the sign
    // convention lives in one place (§6.3).
    objects.xform.position.set(xf.posX(index), flipY(xf.posY(index)));
    objects.xform.visible = xf.visible(index);

    const record = ctx.nodes.recordAt(index);
    if (record !== null) objects.xform.zIndex = record.layer;

    const art = objects.art;
    // A group has no art: its rotation, scale, alpha and tint are stored and queryable but never
    // drawn (§6.2).
    if (art === null) return;

    art.scale.set(xf.scaleX(index), xf.scaleY(index));
    art.rotation = pixiRotation(xf.rotation(index));
    art.alpha = xf.alpha(index);
    art.tint = xf.tint(index);
    // `anchor` is the 0..1 pivot inside this node's own art — not hierarchy (§5).
    art.anchor.set(xf.anchorX(index), xf.anchorY(index));
}

/** Recomputes `renderable` for every live node. */
function updateCulling(ctx: FlushContext): void {
    for (const index of ctx.nodes.liveIndices()) {
        const objects = ctx.objectsAt(index);
        if (objects === undefined) continue;

        const draw = shouldDraw(ctx, index);
        ctx.xf.setCulled(index, !draw);
        // Toggles `art` ONLY. Children are siblings of `art`, so culling a parent cannot hide
        // them (§8).
        setArtRenderable(objects, draw);
    }
}

/** The §8 cull decision for one slot. */
function shouldDraw(ctx: FlushContext, index: number): boolean {
    const record = ctx.nodes.recordAt(index);
    if (record === null) return false;

    // Groups have zero extent, UI is never culled, and `neverCull` covers visuals that exceed
    // their bounds — thick stroke, glow, emitter (§8).
    if (record.kind === 'group') return true;
    if (!isCameraTransformed(record.surface)) return true;
    if (ctx.xf.neverCull(index)) return true;
    if (!ctx.surfaceVisible(record.surface)) return true;

    const local = spriteLocalBounds(
        ctx.sizeAt(index),
        ctx.xf.scaleX(index),
        ctx.xf.scaleY(index),
        ctx.xf.anchorX(index),
        ctx.xf.anchorY(index),
        scratchLocal,
    );
    const world = worldAabb(
        local,
        // The node's OWN rotation: rotation does not inherit, so there is no ancestor walk (§8).
        ctx.xf.rotation(index),
        ctx.xf.resolvedX(index),
        ctx.xf.resolvedY(index),
        scratchWorld,
    );
    return isVisibleInViewport(world, ctx.viewport, ctx.cullMargin);
}

/** A zero-extent local rect, for callers that need a group's bounds. */
export function groupBounds(out?: Bounds): Bounds {
    return emptyLocalBounds(out);
}

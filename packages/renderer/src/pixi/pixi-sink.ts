// The Pixi half of the `SceneSink` seam: display objects and nothing else, and the only place in
// the backend that touches an xform/art pair — which is what keeps the tree shape enforceable.

import type { Container } from 'pixi.js';
import type { Bounds, Size } from '@platform/math';
import { bounds, boundsCopy, vec3 } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import type { NodeRecord } from '../node-store.js';
import type { TransformStore } from '../transform-store.js';
import type { SceneSink } from '../core/scene-sink.js';
import { NO_PARENT } from '../core/scene-sink.js';
import { flipY, pixiRotation, uiAnchorOrigin } from '../projection.js';
import { isScreenSpace } from '../surfaces.js';
import { fitScale } from '../viewport.js';
import type { AssetRegistry } from './asset-registry.js';
import { measureText } from './text-raster.js';
import type { SurfaceTree } from './surface-tree.js';
import type { NodeObjects } from './node-tree.js';
import {
    attachXform,
    createNodeObjects,
    destroyNodeObjects,
    reparentXform,
    setArtRenderable,
    setArtText,
    setArtTexture,
} from './node-tree.js';

/** Fallback when a texture name is not resident — the placeholder is 1x1. */
const PLACEHOLDER_SIZE: Size = { width: 1, height: 1 };

/** Creates and mutates the xform/art pairs the core asks for. */
export class PixiSink implements SceneSink {
    /** Slot index -> display objects. Rebuilt wholesale after a context loss. */
    readonly #objects = new Map<number, NodeObjects>();

    readonly #surfaces: SurfaceTree;
    readonly #assets: AssetRegistry;

    /**
     * The core's transform store, supplied by {@link bind}.
     *
     * Late-bound because the core takes a sink in its constructor while the sink reads the store
     * the core owns; the core calls no sink method while constructing, so binding after is safe.
     */
    #xf: TransformStore | null = null;

    /** Screen-space slots, so a stage change can re-place them without scanning every node. */
    readonly #screenSpace = new Map<number, NodeRecord>();

    /** Measured text size per slot, keyed by the string it was measured from. */
    readonly #textSize = new Map<number, { text: string; size: Size }>();

    /** The stage rect and design scale the last {@link applyView} supplied. */
    readonly #stage: Bounds = bounds();
    #fitScale = 1;
    readonly #origin = vec3();

    constructor(surfaces: SurfaceTree, assets: AssetRegistry) {
        this.#surfaces = surfaces;
        this.#assets = assets;
    }

    /** Hands the sink the core's transform store. Call once, right after constructing the core. */
    bind(xf: TransformStore): void {
        this.#xf = xf;
    }

    /** The pair for a slot. Test-only: placement is otherwise unobservable without a GPU. */
    objectsAt(index: number): NodeObjects | undefined {
        return this.#objects.get(index);
    }

    create(index: number, record: NodeRecord, parentIndex: number): void {
        const objects = createNodeObjects(
            record.kind,
            this.#assets.get(record.texture),
            record.text,
            record.style,
        );
        const parent = this.#containerFor(record.surface, parentIndex);
        if (parent === undefined) {
            // Nothing to attach to, so the pair would leak: the core still holds the node, and its
            // next write is a no-op.
            destroyNodeObjects(objects);
            return;
        }

        attachXform(objects, parent, record.layer);
        this.#objects.set(index, objects);
        if (isScreenSpace(record.surface)) this.#screenSpace.set(index, record);
    }

    reparent(index: number, record: NodeRecord, parentIndex: number): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        const parent = this.#containerFor(record.surface, parentIndex);
        if (parent === undefined) return;
        reparentXform(objects, parent);
    }

    destroySubtree(subtree: readonly number[]): void {
        // Destroying the root cascades, because descendants are real children of its xform, so they
        // need only their bookkeeping dropped.
        const root = subtree[0];
        if (root !== undefined) {
            const objects = this.#objects.get(root);
            if (objects !== undefined) destroyNodeObjects(objects);
        }
        for (const index of subtree) {
            this.#objects.delete(index);
            this.#screenSpace.delete(index);
            this.#textSize.delete(index);
        }
    }

    /**
     * Pushes a node's local values: `xform` takes what inherits, `art` what does not.
     *
     * A world node's y is flipped and its offset is world px; a screen-space node's is not flipped
     * and is design px, so it carries `fitScale` and — when it is a surface root — its UI anchor
     * origin. Both go through `projection.ts`, so the sign and anchor conventions live in one place.
     */
    write(index: number, record: NodeRecord): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        const xf = this.#xf;
        if (xf === null) return;

        const screen = isScreenSpace(record.surface);
        const s = screen ? this.#fitScale : 1;

        if (screen) {
            // A child's origin arrives through its parent's xform, so only a surface root adds the
            // anchor origin — which is also what keeps this in step with `screenPositionOf`.
            let originX = 0;
            let originY = 0;
            if (xf.parent(index) === NO_PARENT) {
                uiAnchorOrigin(record.uiAnchor ?? 'top-left', this.#stage, this.#origin);
                originX = this.#origin.x;
                originY = this.#origin.y;
            }
            objects.xform.position.set(originX + xf.posX(index) * s, originY + xf.posY(index) * s);
        } else {
            objects.xform.position.set(xf.posX(index), flipY(xf.posY(index)));
        }

        objects.xform.visible = xf.visible(index);
        objects.xform.zIndex = record.layer;

        const art = objects.art;
        if (art === null) return;

        // `fitScale` multiplies the authored scale rather than riding on the xform, because a scale
        // on the xform would inherit and UI scale would then compound per level.
        art.scale.set(xf.scaleX(index) * s, xf.scaleY(index) * s);
        art.rotation = pixiRotation(xf.rotation(index));
        art.alpha = xf.alpha(index);
        art.tint = xf.tint(index);
        // The 0..1 pivot inside this node's own art — not hierarchy.
        art.anchor.set(xf.anchorX(index), xf.anchorY(index));
    }

    setRenderable(index: number, renderable: boolean): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        // The art only: children are siblings of it, so culling a parent cannot hide them.
        setArtRenderable(objects, renderable);
    }

    setTexture(index: number, record: NodeRecord): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        setArtTexture(objects, this.#assets.get(record.texture));
    }

    setText(index: number, text: string): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        this.#textSize.delete(index);
        setArtText(objects, text);
    }

    setLayer(index: number, layer: number): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        objects.xform.zIndex = layer;
    }

    sizeOf(index: number, record: NodeRecord): Size {
        if (record.kind !== 'text') return this.#assets.sizeOf(record.texture) ?? PLACEHOLDER_SIZE;

        // Measuring lays the string out on a 2D canvas, so a repeated bounds query over unchanged
        // text must not pay for it twice.
        const cached = this.#textSize.get(index);
        if (cached !== undefined && cached.text === record.text) return cached.size;

        const size = measureText(record.text, record.style);
        this.#textSize.set(index, { text: record.text, size });
        return size;
    }

    applyView(
        camera: Readonly<CameraState>,
        scaleMode: ScaleMode,
        canvas: Size,
        design: Size,
        stage: Readonly<Bounds>,
        letterbox: boolean,
    ): void {
        this.#surfaces.applyCamera(camera, scaleMode, canvas, design);
        this.#surfaces.applyLetterbox(stage, camera, scaleMode, letterbox);

        // UI placement is anchored to the stage and scaled by `fitScale`, so a stage that actually
        // moved has to re-place every screen-space node — and one that did not must cost nothing,
        // since `setCamera` reaches here every frame.
        const scale = fitScale(camera.framing ?? 'stage', scaleMode, canvas, design);
        if (scale === this.#fitScale && sameRect(this.#stage, stage)) return;

        this.#fitScale = scale;
        boundsCopy(this.#stage, stage);
        for (const [index, record] of this.#screenSpace) this.write(index, record);
    }

    surfaceVisible(surface: Surface): boolean {
        return this.#surfaces.root(surface)?.visible ?? false;
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        this.#surfaces.setVisible(surface, visible);
    }

    clearAll(): void {
        for (const objects of this.#objects.values()) destroyNodeObjects(objects);
        this.#objects.clear();
        this.#screenSpace.clear();
        this.#textSize.clear();
    }

    /** Repoints the given sprites at the placeholder, after their texture was unloaded. */
    repointToPlaceholder(slots: readonly number[]): void {
        for (const index of slots) {
            const objects = this.#objects.get(index);
            if (objects !== undefined) setArtTexture(objects, this.#assets.placeholder);
        }
    }

    #containerFor(surface: Surface, parentIndex: number): Container | undefined {
        return parentIndex === NO_PARENT
            ? this.#surfaces.root(surface)
            : this.#objects.get(parentIndex)?.xform;
    }
}

function sameRect(a: Readonly<Bounds>, b: Readonly<Bounds>): boolean {
    return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
}

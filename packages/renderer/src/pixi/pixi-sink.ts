// The Pixi half of the `SceneSink` seam: display objects and nothing else.
//
// Everything backend-independent — stores, validation, hierarchy, projection, bounds, culling —
// lives in `core/renderer-core.ts`. This file is the only place in the Pixi backend that touches
// an xform/art pair, which is what keeps §6.2's tree shape enforceable in one readable place.

import type { Container } from 'pixi.js';
import type { Bounds, Size } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import type { NodeRecord } from '../node-store.js';
import type { TransformStore } from '../transform-store.js';
import type { SceneSink } from '../core/scene-sink.js';
import { NO_PARENT } from '../core/scene-sink.js';
import { flipY, pixiRotation } from '../projection.js';
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
    /** slot index -> display objects. Rebuilt wholesale after a context loss (§10). */
    readonly #objects = new Map<number, NodeObjects>();

    readonly #surfaces: SurfaceTree;
    readonly #assets: AssetRegistry;

    /**
     * The core's transform store, supplied by {@link bind}.
     *
     * Late-bound because the core and the sink each need the other: the core takes a sink in its
     * constructor, and the sink reads the store the core owns. The core touches no sink method
     * while constructing, so binding immediately afterwards is safe — and an unbound sink throws
     * rather than silently writing nothing.
     */
    #xf: TransformStore | null = null;

    constructor(surfaces: SurfaceTree, assets: AssetRegistry) {
        this.#surfaces = surfaces;
        this.#assets = assets;
    }

    /** Hands the sink the core's transform store. Call once, right after constructing the core. */
    bind(xf: TransformStore): void {
        this.#xf = xf;
    }

    /** The pair for a slot, for anything that needs to reach a display object directly. */
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
        if (parent === undefined) return;

        attachXform(objects, parent, record.layer);
        this.#objects.set(index, objects);
    }

    reparent(index: number, record: NodeRecord, parentIndex: number): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        const parent = this.#containerFor(record.surface, parentIndex);
        if (parent === undefined) return;
        reparentXform(objects, parent);
    }

    destroySubtree(root: number, descendants: readonly number[]): void {
        // Destroying the root pair cascades in Pixi too, because descendants are real children of
        // the xform (§6.2) — so only the root's objects are destroyed, and the descendants just
        // need their bookkeeping dropped.
        const objects = this.#objects.get(root);
        if (objects !== undefined) destroyNodeObjects(objects);

        this.#objects.delete(root);
        for (const index of descendants) this.#objects.delete(index);
    }

    /**
     * Pushes a node's LOCAL values.
     *
     * The split is exactly §6.2's: `xform` takes what inherits (position, visibility), `art` takes
     * what does not (scale, rotation, alpha, tint, anchor). The y-flip is arithmetic here, at the
     * write boundary, via `flipY`/`pixiRotation` rather than an open-coded minus (§6.3).
     */
    write(index: number, record: NodeRecord): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        const xf = this.#xf;
        if (xf === null) return;

        objects.xform.position.set(xf.posX(index), flipY(xf.posY(index)));
        objects.xform.visible = xf.visible(index);
        objects.xform.zIndex = record.layer;

        const art = objects.art;
        // A group has no art: its rotation, scale, alpha and tint are stored and queryable but
        // never drawn (§6.2).
        if (art === null) return;

        art.scale.set(xf.scaleX(index), xf.scaleY(index));
        art.rotation = pixiRotation(xf.rotation(index));
        art.alpha = xf.alpha(index);
        art.tint = xf.tint(index);
        // `anchor` is the 0..1 pivot inside this node's own art — not hierarchy (§5).
        art.anchor.set(xf.anchorX(index), xf.anchorY(index));
    }

    setRenderable(index: number, renderable: boolean): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        // Toggles `art` ONLY. Children are siblings of art, so culling a parent cannot hide
        // them (§8).
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
        setArtText(objects, text);
    }

    setLayer(index: number, layer: number): void {
        const objects = this.#objects.get(index);
        if (objects === undefined) return;
        objects.xform.zIndex = layer;
    }

    sizeOf(_index: number, record: NodeRecord): Size {
        if (record.kind === 'text') return measureText(record.text, record.style);
        return this.#assets.sizeOf(record.texture) ?? PLACEHOLDER_SIZE;
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
    }

    /** Repoints every sprite using `name` at the placeholder, after an unload (§9.2). */
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

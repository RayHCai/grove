// The seam between the backend-independent core and a backend's display objects.
//
// Everything a backend must supply is here, and it is deliberately small: create/reparent/destroy
// a node's objects, push its local values, toggle its art, and answer how big it is. Everything
// else — the stores, validation, hierarchy, projection, bounds, culling — lives in
// `renderer-core.ts` in ONE copy.
//
// Indices, not `NodeId`s: handle validation already happened in the core, and both stores are
// addressed by slot index (§6.1, §7).

import type { Bounds, Size } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import type { NodeRecord } from '../node-store.js';

/** `parentIndex` when a node is a root of its surface. */
export const NO_PARENT = -1;

/**
 * What a backend implements. The core calls these; it never touches a display object itself.
 *
 * Every method is allowed to be a no-op — that is exactly what the headless backend does.
 */
export interface SceneSink {
    /**
     * Creates the display objects for a node and attaches them under `parentIndex`, or under the
     * node's surface root when `parentIndex` is {@link NO_PARENT}.
     */
    create(index: number, record: NodeRecord, parentIndex: number): void;

    /** Moves a node's objects under a new parent, or its surface root for {@link NO_PARENT}. */
    reparent(index: number, record: NodeRecord, parentIndex: number): void;

    /**
     * Destroys the objects for `root` and its `descendants`.
     *
     * Both are passed because a backend with a nested tree gets the cascade for free from the
     * root and only needs the descendant list to drop bookkeeping (§6.2), while a flat backend
     * can walk the list.
     */
    destroySubtree(root: number, descendants: readonly number[]): void;

    /** Pushes a node's LOCAL transform values. Called once per flush-dirty node (§6.2). */
    write(index: number, record: NodeRecord): void;

    /** Toggles whether a node's ART draws — never its children (§8). */
    setRenderable(index: number, renderable: boolean): void;

    /** A sprite node's texture name changed. */
    setTexture(index: number, record: NodeRecord): void;

    /** A UI text node's string changed. */
    setText(index: number, text: string): void;

    /** A node's draw order within its parent changed. */
    setLayer(index: number, layer: number): void;

    /**
     * The texture or measured size behind a node, for bounds and culling.
     *
     * The one genuinely backend-specific input to the shared math: a GPU backend measures text
     * with a font, a headless one cannot.
     */
    sizeOf(index: number, record: NodeRecord): Size;

    /** Applies the camera and the letterbox mask to the surface roots (§6.4). */
    applyView(
        camera: Readonly<CameraState>,
        scaleMode: ScaleMode,
        canvas: Size,
        design: Size,
        stage: Readonly<Bounds>,
        letterbox: boolean,
    ): void;

    /** `false` when a surface's root is hidden, so the core can skip its cull arithmetic. */
    surfaceVisible(surface: Surface): boolean;

    /** Shows or hides a surface root. */
    setSurfaceVisible(surface: Surface, visible: boolean): void;

    /** Drops every display object. */
    clearAll(): void;
}

// The seam between the backend-independent core and a backend's display objects.
// Indices, not `NodeId`s: handle validation already happened in the core.

import type { Bounds, Size } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import type { NodeRecord } from '../node-store.js';

/** `parentIndex` when a node is a root of its surface. */
export const NO_PARENT = -1;

/** What a backend implements; the core never touches a display object. Every method may no-op. */
export interface SceneSink {
    /**
     * Creates the display objects for a node and attaches them under `parentIndex`, or under the
     * node's surface root when `parentIndex` is {@link NO_PARENT}.
     */
    create(index: number, record: NodeRecord, parentIndex: number): void;

    /** Moves a node's objects under a new parent, or its surface root for {@link NO_PARENT}. */
    reparent(index: number, record: NodeRecord, parentIndex: number): void;

    /** Destroys the objects for a subtree, root first; a nested tree cascades from `subtree[0]`. */
    destroySubtree(subtree: readonly number[]): void;

    /** Pushes a node's local transform values. Called once per flush-dirty node. */
    write(index: number, record: NodeRecord): void;

    /** Toggles whether a node's art draws — never its children. */
    setRenderable(index: number, renderable: boolean): void;

    /** A sprite node's texture name changed. */
    setTexture(index: number, record: NodeRecord): void;

    /** A UI text node's string changed. */
    setText(index: number, text: string): void;

    /** A node's draw order within its parent changed. */
    setLayer(index: number, layer: number): void;

    /** The texture or measured size behind a node; the one backend-specific input to the math. */
    sizeOf(index: number, record: NodeRecord): Size;

    /** Applies the camera and the letterbox mask to the surface roots. */
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

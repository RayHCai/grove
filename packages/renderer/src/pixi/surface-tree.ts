// The surface roots, the camera application, and the letterbox mask.
//
// Only enabled surfaces get containers, so a shipped game allocates no editor objects at all.
//
// The camera lives on the surface root, never baked into node values, which is what makes
// `setCamera` touch one container and zero nodes.

import { Container, Graphics } from 'pixi.js';
import type { Bounds, Size } from '@platform/math';
import { bounds, boundsCopy, boundsEqual, boundsHeight, boundsWidth } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import { SURFACE_ORDER, isCameraTransformed, isClippedWhenLetterboxed } from '../surfaces.js';
import { cameraScale } from '../projection.js';
import { isLetterboxed } from '../viewport.js';

/** The surface roots, in draw order, with the camera and mask applied to them. */
export class SurfaceTree {
    readonly #roots = new Map<Surface, Container>();
    readonly #masks = new Map<Surface, Graphics>();

    /** Whether a mask is currently recorded, so an unchanged stage re-records nothing. */
    #maskActive = false;

    /** The stage rect the recorded mask was built from. Meaningless while `#maskActive` is false. */
    readonly #maskRect: Bounds = bounds();

    /** The container every surface root is added to. */
    readonly stage: Container;

    constructor(stage: Container, enabled: readonly Surface[]) {
        this.stage = stage;

        // Added in SURFACE_ORDER, so container order is draw order and no zIndex is needed.
        for (const surface of SURFACE_ORDER) {
            if (!enabled.includes(surface)) continue;
            const root = new Container();
            root.label = `surface:${surface}`;
            // Roots hold nodes whose relative order comes from `layer`.
            root.sortableChildren = true;
            this.#roots.set(surface, root);
            this.stage.addChild(root);
        }
    }

    /** The root container for a surface, or `undefined` when it is disabled. */
    root(surface: Surface): Container | undefined {
        return this.#roots.get(surface);
    }

    /** Toggles a root's visibility. A disabled surface is a silent no-op. */
    setVisible(surface: Surface, visible: boolean): void {
        const root = this.#roots.get(surface);
        if (root === undefined) return;
        root.visible = visible;
    }

    /**
     * Applies the camera to the camera-transformed roots.
     *
     * The scale is positive and uniform: a negative `scale.y` would be the tempting way to get
     * y-up and mirrors every sprite and glyph in the tree. The y-flip is arithmetic at the write
     * boundary instead, which is why the y term below reads as a plus.
     */
    applyCamera(
        camera: Readonly<CameraState>,
        scaleMode: ScaleMode,
        canvas: Size,
        design: Size,
    ): void {
        const s = cameraScale(camera, scaleMode, canvas, design);
        const camX = camera.position.x;
        const camY = camera.position.y;

        for (const [surface, root] of this.#roots) {
            if (!isCameraTransformed(surface)) continue;
            root.scale.set(s);
            root.position.set(canvas.width / 2 - camX * s, canvas.height / 2 + camY * s);
        }
    }

    /**
     * Masks the game surfaces to the stage rect when bars are actually drawn.
     *
     * Editor chrome is never clipped, so a bar cannot cut off a gizmo. `stage` is screen space.
     */
    applyLetterbox(
        stageRect: Readonly<Bounds>,
        camera: Readonly<CameraState>,
        scaleMode: ScaleMode,
        letterbox: boolean,
    ): void {
        const active = isLetterboxed(camera.framing ?? 'stage', scaleMode, letterbox);

        // `clear()` + `rect()` + `fill()` costs a re-triangulation and a buffer upload, and this
        // runs off `setCamera` — every frame — for a rectangle that only changes on resize.
        if (active === this.#maskActive && (!active || boundsEqual(this.#maskRect, stageRect))) {
            return;
        }
        this.#maskActive = active;
        if (active) boundsCopy(this.#maskRect, stageRect);

        for (const [surface, root] of this.#roots) {
            if (!isClippedWhenLetterboxed(surface)) continue;

            if (!active) {
                this.#clearMask(surface, root);
                continue;
            }

            let mask = this.#masks.get(surface);
            if (mask === undefined) {
                mask = new Graphics();
                mask.label = `mask:${surface}`;
                this.#masks.set(surface, mask);
                // A sibling of the masked root, not a child: a child would be transformed by the
                // camera and would stop matching the screen-space stage rect.
                this.stage.addChild(mask);
                root.mask = mask;
            }

            mask.clear();
            mask.rect(
                stageRect.left,
                Math.min(stageRect.top, stageRect.bottom),
                boundsWidth(stageRect),
                boundsHeight(stageRect),
            ).fill(0xffffff);
        }
    }

    /** Destroys every root and mask. */
    destroy(): void {
        this.#maskActive = false;
        for (const [surface, root] of this.#roots) {
            this.#clearMask(surface, root);
            root.destroy({ children: true });
        }
        this.#roots.clear();
    }

    #clearMask(surface: Surface, root: Container): void {
        const mask = this.#masks.get(surface);
        if (mask === undefined) return;
        root.mask = null;
        mask.destroy();
        this.#masks.delete(surface);
    }
}

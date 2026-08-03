// The five surface roots, the camera application, and the letterbox mask (§4, §4.1, §6.4).
//
// Only ENABLED surfaces get containers, so a shipped game allocates no editor objects at all
// (§4). Draw order is `SURFACE_ORDER` and is not configurable — a UI node can never sort beneath
// a world node regardless of `layer`, and `editorOverlay` sits above `ui` on purpose so a gizmo
// stays grabbable over the widget it moves.
//
// THE CAMERA LIVES HERE, on the surface root, never baked into node values — which is what makes
// `setCamera` touch one container and zero nodes (§6.4).

import { Container, Graphics } from 'pixi.js';
import type { Bounds, Size } from '@platform/math';
import { boundsHeight, boundsWidth } from '@platform/math';
import type { CameraState, ScaleMode, Surface } from '../renderer.js';
import { SURFACE_ORDER, isCameraTransformed, isClippedWhenLetterboxed } from '../surfaces.js';
import { cameraScale } from '../projection.js';
import { isLetterboxed } from '../viewport.js';

/** The surface roots, in draw order, with the camera and mask applied to them. */
export class SurfaceTree {
    readonly #roots = new Map<Surface, Container>();
    readonly #masks = new Map<Surface, Graphics>();

    /** The container every surface root is added to. */
    readonly stage: Container;

    constructor(stage: Container, enabled: readonly Surface[]) {
        this.stage = stage;

        // Added in SURFACE_ORDER, so container order IS draw order and no zIndex is needed.
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
     * Applies the camera to the three camera-transformed roots (§6.4).
     *
     * ```
     * s = fitScale * zoom
     * root.scale    = s                                    // uniform, POSITIVE
     * root.position = { x: cw/2 - cam.x * s, y: ch/2 + cam.y * s }
     * ```
     *
     * The scale is POSITIVE and UNIFORM. A negative `scale.y` would be the tempting way to get
     * y-up and is explicitly wrong — it mirrors every sprite and every glyph in the tree. The
     * y-flip is arithmetic at the write boundary instead (§6.3), which is why the `+ cam.y * s`
     * above reads as a plus while a world-to-screen y reads as a minus.
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
     * Editor chrome is never clipped — `editorOverlay` and `editorUi` must stay fully visible, and
     * `'free'` framing (what the editor uses) forces letterboxing off anyway. `stage` is screen
     * space, y-down.
     */
    applyLetterbox(
        stageRect: Readonly<Bounds>,
        camera: Readonly<CameraState>,
        scaleMode: ScaleMode,
        letterbox: boolean,
    ): void {
        const active = isLetterboxed(camera.framing ?? 'stage', scaleMode, letterbox);

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
                // The mask is a sibling of the masked root, not a child: a child would be
                // transformed by the camera and would stop matching the screen-space stage rect.
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

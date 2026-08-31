// The DOM device, localized to a canvas.
//
// `createDomInputDevice` reports `PointerEvent.clientX/clientY` — CSS pixels from the BROWSER
// viewport's top-left, y-down — which is the only thing a listener can honestly say. Every use of a
// pointer past that point wants one of two other spaces: canvas pixels, which is what `entityAt`
// picks in, or world units, which is the only space an authority can reason about. This does that
// conversion once, where the DOM geometry already lives, so an app does not carry a
// `getBoundingClientRect` of its own.
//
// It deliberately does NOT rewrite the coordinates on the forwarded event. `cursorX`/`cursorY`
// bindings quantize against the WORLD-space viewport, so feeding them world coordinates looks like
// the fix — but the axis quantizer reads exactly 0 as a return to neutral and drops it, which would
// silently swallow every press on the world's centre line. An app that wants the pointer on the
// wire emits its own axis from `onPress`, biased clear of zero.

import type { EmittingInputDevice, RawInputEvent } from '../input.js';
import { createDomInputDevice } from './input-device.js';

/** Just enough of `IRenderer` to convert a point — passed as a value, so a test needs no renderer. */
export interface ScreenToWorld {
    screenToWorld(point: { x: number; y: number }): { x: number; y: number };
}

/** One press, in all three spaces, so a caller picks the one its next call takes. */
export interface CanvasPress {
    /** Which button, as `PointerEvent.button` numbers it. */
    button: number;
    /** Canvas pixels, y-down. What `GameClient.entityAt` takes. */
    canvasX: number;
    canvasY: number;
    /**
     * World units, y-up.
     *
     * Non-finite before the renderer has a camera and a viewport — a degenerate camera has no world
     * point to name. Canvas pixels are always meaningful, so a caller that only picks may ignore
     * this; a caller that puts it on the wire must check, because one non-finite `value` makes the
     * server drop the whole input frame with no reply.
     */
    worldX: number;
    worldY: number;
}

export interface CanvasInputOptions {
    /** The element the canvas fills. Pointer coordinates are taken relative to its content box. */
    container: HTMLElement;
    /** Read per event rather than once: `screenToWorld` needs the camera as it stands now. */
    renderer: ScreenToWorld;
    /** Each pointer press, converted. Runs BEFORE the event itself is forwarded. */
    onPress?: (press: CanvasPress) => void;
    /**
     * Forward `pointerMove`. Off by default.
     *
     * A `cursorX`/`cursorY` binding resolves on every move, and an axis edge is sent whenever the
     * value clears its quantum — so a game that binds neither pays a full binding-resolution pass
     * per mouse move to discover nothing is bound. Turn it on for a game that aims continuously.
     */
    pointerMoves?: boolean;
}

/**
 * Wraps the DOM device with the canvas geometry, and reports each press in every space.
 *
 * `emit` is forwarded, so a polled device — {@link pollGamepads} — still feeds the same handler.
 */
export function createCanvasInputDevice(opts: CanvasInputOptions): EmittingInputDevice {
    const dom = createDomInputDevice({ target: opts.container });
    let downstream: ((event: RawInputEvent) => void) | undefined;
    let disposed = false;

    return {
        onRaw(handler: (event: RawInputEvent) => void): () => void {
            downstream = handler;
            const dispose = dom.onRaw((event: RawInputEvent) => {
                if (event.kind === 'pointerMove' && opts.pointerMoves !== true) return;

                if (event.kind === 'pointer' && event.down && opts.onPress !== undefined) {
                    const canvas = canvasPoint(opts.container, event.screenX, event.screenY);
                    const world = opts.renderer.screenToWorld(canvas);
                    opts.onPress({
                        button: event.button,
                        canvasX: canvas.x,
                        canvasY: canvas.y,
                        worldX: world.x,
                        worldY: world.y,
                    });
                }

                handler(event);
            });
            return () => {
                if (downstream === handler) downstream = undefined;
                dispose();
            };
        },

        emit(event: RawInputEvent): void {
            downstream?.(event);
        },

        dispose(): void {
            if (disposed) return;
            disposed = true;
            downstream = undefined;
            dom.dispose();
        },
    };
}

/**
 * A viewport-relative pointer position, in the canvas's own pixels.
 *
 * Screen space starts at the CANVAS, which fills the container's content box — so the container's
 * own border comes off too, or every click resolves inside it by the border width.
 */
export function canvasPoint(
    container: HTMLElement,
    screenX: number,
    screenY: number,
): { x: number; y: number } {
    const rect = container.getBoundingClientRect();
    return {
        x: screenX - rect.left - container.clientLeft,
        y: screenY - rect.top - container.clientTop,
    };
}

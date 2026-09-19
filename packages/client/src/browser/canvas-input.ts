// Coordinates on the forwarded event are deliberately NOT rewritten to world space: the axis
// quantizer reads exactly 0 as neutral, which would swallow every press on the world's centre line.

import type { EmittingInputDevice, RawInputEvent } from '../input.js';
import { createDomInputDevice } from './input-device.js';

/** Just enough of `IRenderer` to convert a point; a value, so a test needs no renderer. */
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
    /** World units, y-up. Non-finite before the camera exists; one on the wire drops the frame. */
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
    /** Forward `pointerMove`. Off by default: an unbound game pays a resolution pass per move. */
    pointerMoves?: boolean;
}

/** Wraps the DOM device with canvas geometry, reporting each press in every space. */
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

/** A viewport-relative pointer position in the canvas's pixels, less the container border. */
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

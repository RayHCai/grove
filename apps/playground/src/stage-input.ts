// The geometry belongs to `createCanvasInputDevice`; what is left here is the aim axis — which
// action carries the click's height, and the bias that keeps it off zero.

import type { EmittingInputDevice } from '@platform/glue/client';
import { createCanvasInputDevice } from '@platform/client/browser';
import type { IRenderer } from '@platform/renderer';
import { CODE_AIM_Y, encodeAim } from './scripts/globals';

export interface StageInputOptions {
    /** The element the canvas fills; pointer coordinates are taken relative to its box. */
    container: HTMLElement;
    /** Read for `screenToWorld`, which needs the live camera and viewport. */
    renderer: IRenderer;
    /**
     * The press in CANVAS space, for the caller that resolves a pointer hit — screen space, not
     * world, since that is what `client.entityAt` takes. A pointer hit never rides a binding.
     */
    onScreenPress?: (x: number, y: number) => void;
}

/**
 * The stage's device: the canvas device, plus a world-space aim sample per click. The sample
 * rides the press's own frame because moves are dropped, so this is the only aim the server gets.
 */
export function createStageInputDevice(opts: StageInputOptions): EmittingInputDevice {
    // `onPress` runs ahead of the press event's own forward, so emitting from inside it puts the
    // axis on the wire before the button — which is the order the aim is wanted in.
    const device: EmittingInputDevice = createCanvasInputDevice({
        container: opts.container,
        renderer: opts.renderer,
        onPress: (press) => {
            // One non-finite `value` makes the server drop the whole input frame with no reply,
            // which reads as a stall rather than as a bad coordinate.
            if (!Number.isFinite(press.worldY)) return;
            device.emit({ kind: 'axis', code: CODE_AIM_Y, value: encodeAim(press.worldY) });
            opts.onScreenPress?.(press.canvasX, press.canvasY);
        },
    });
    return device;
}

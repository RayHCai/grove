// The one thing about input that is this GAME's rather than this platform's: what a click means.
//
// The geometry — viewport pixels to canvas pixels to world units — is `createCanvasInputDevice`,
// because a container's border box is a DOM fact and belongs beside the other DOM code. What is
// left here is the aim axis: which action carries the click's height, and the bias that keeps it
// off zero.

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
     * The press in CANVAS space, for the caller that resolves a pointer hit.
     *
     * Screen space rather than world, because that is what `client.entityAt` takes: picking runs
     * against what is DRAWN, and the drawn pose of anything this client does not predict is a send
     * interval behind the simulated one. A second route out of the same event rather than a second
     * subscriber — `onRaw` holds one handler, which is the client's — and a pointer hit is not an
     * input action, so it never belongs on a binding.
     */
    onScreenPress?: (x: number, y: number) => void;
}

/**
 * The stage's device: the canvas device, plus a world-space aim sample per click.
 *
 * The sample rides the press's own frame because moves are dropped — a plain axis binding quantizes
 * at 1/64 of the viewport, so streaming the cursor would put an edge on the wire for practically
 * every mouse move, to say where a leaf will not be spawned. This is therefore the only aim the
 * server ever gets, and `Clicker` reads it a pass later: a press is dispatched before that tick's
 * axis samples are.
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

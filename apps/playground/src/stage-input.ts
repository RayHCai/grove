// The device seam, with the one conversion neither package performs.
//
// `createDomInputDevice` emits `PointerEvent.clientX/clientY` — CSS px from the BROWSER viewport's
// top-left, y-down — and `cursorX`/`cursorY` bindings put that number on the wire unchanged. The
// server has no canvas, no camera and no idea what a CSS pixel is there, so the click is converted
// to world space here, on the only side that can.

import type { EmittingInputDevice, RawInputEvent } from '@platform/client';
import { createDomInputDevice } from '@platform/client/browser';
import type { IRenderer } from '@platform/renderer';
import { CODE_AIM_Y, encodeAim } from './shared';

export interface StageInputOptions {
    /** The element the canvas fills; pointer coordinates are taken relative to its box. */
    container: HTMLElement;
    /** Read for `screenToWorld`, which needs the live camera and viewport. */
    renderer: IRenderer;
}

/**
 * Wraps the DOM device and rewrites each click into a world-space aim sample.
 *
 * `pointerMove` is dropped rather than forwarded: a plain axis binding quantizes at 1/64 of a unit,
 * so streaming the cursor would put an edge on the wire for practically every mouse move, to say
 * where a leaf will not be spawned.
 */
export function createStageInputDevice(opts: StageInputOptions): EmittingInputDevice {
    const dom = createDomInputDevice({ target: opts.container });
    let downstream: ((event: RawInputEvent) => void) | undefined;
    let disposed = false;

    return {
        onRaw(handler: (event: RawInputEvent) => void): () => void {
            downstream = handler;
            const dispose = dom.onRaw((event: RawInputEvent) => {
                if (event.kind === 'pointerMove') return;

                if (event.kind === 'pointer' && event.down) {
                    // Emitted from the press's own handler because `pointerMove` is dropped: this
                    // is the only aim sample the server gets, and it has to ride the press's frame.
                    const aim = aimFor(opts, event.screenX, event.screenY);
                    if (aim !== null) handler({ kind: 'axis', code: CODE_AIM_Y, value: aim });
                }

                handler(event);
            });
            return () => {
                if (downstream === handler) downstream = undefined;
                dispose();
            };
        },
        /** Lets a UI control synthesize a device edge — the HUD's clear button is one. */
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
 * The click's world y, biased, or `null` if it cannot be trusted.
 *
 * One non-finite `value` makes the server drop the whole input frame with no reply, which reads as
 * a stall rather than as a bad coordinate — so a bad reading is dropped here instead.
 */
function aimFor(opts: StageInputOptions, screenX: number, screenY: number): number | null {
    const rect = opts.container.getBoundingClientRect();
    // Screen space starts at the CANVAS, which fills the container's content box — so the
    // container's own border comes off too, or every click resolves a pixel low.
    const world = opts.renderer.screenToWorld({
        x: screenX - rect.left - opts.container.clientLeft,
        y: screenY - rect.top - opts.container.clientTop,
    });
    if (!Number.isFinite(world.y)) return null;
    return encodeAim(world.y);
}

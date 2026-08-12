// The rAF frame source, behind the `./browser` subpath so importing the client never drags a DOM adapter
// into a Node test's module graph.

import type { FrameSource } from '../input.js';

/**
 * `requestAnimationFrame`, in seconds.
 *
 * The timestamp is converted here rather than in `frame()` because every number the clock holds is in
 * seconds, and a millisecond leaking in would read as a 1000× lead.
 */
export function createRafFrameSource(): FrameSource {
    let handle = 0;
    let running = false;

    return {
        start(onFrame: (nowSeconds: number) => void): void {
            if (running) return;
            running = true;
            const loop = (nowMs: number): void => {
                if (!running) return;
                // Scheduled before the callback, so a `stop()` from inside it cancels this handle rather
                // than being overwritten by it.
                handle = requestAnimationFrame(loop);
                onFrame(nowMs / 1000);
            };
            handle = requestAnimationFrame(loop);
        },

        stop(): void {
            running = false;
            if (handle !== 0) cancelAnimationFrame(handle);
            handle = 0;
        },
    };
}

/** The injected wall-clock: one source, converted once, never `Date.now()` at a call site. */
export function createPerformanceClock(): { nowSeconds(): number } {
    return { nowSeconds: () => performance.now() / 1000 };
}

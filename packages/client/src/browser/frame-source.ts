import type { FrameSource } from '../input.js';

/** `requestAnimationFrame`, in seconds — every number the clock holds is in seconds. */
export function createRafFrameSource(): FrameSource {
    let handle = 0;
    let running = false;

    return {
        start(onFrame: (nowSeconds: number) => void): void {
            if (running) return;
            running = true;
            const loop = (nowMs: number): void => {
                if (!running) return;
                // Scheduled before the callback, so a `stop()` from inside it cancels this handle.
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

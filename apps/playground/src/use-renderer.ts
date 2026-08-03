// The React <-> IRenderer seam: mount, init, frame loop, teardown.
//
// THE RENDERER LIVES IN A REF, NEVER IN STATE. It is a mutable GPU-backed object whose identity
// never changes; putting it in state would re-render every consumer for nothing, and — worse —
// invite React to treat it as a value to be copied. State here carries only what the UI actually
// draws: the load phase and any error.
//
// `render()` is explicit and takes no `dt`, because the renderer owns no clock (§11.1). This hook
// is that clock.

import { useEffect, useRef, useState } from 'react';
import type { IRenderer, RendererInitOptions } from '@platform/renderer';
import { createPixiRenderer } from '@platform/renderer/pixi';

/** Frame callback. `dt` is seconds since the previous frame, already clamped. */
export type FrameHandler = (dt: number, renderer: IRenderer) => void;

export type RendererPhase = 'idle' | 'initializing' | 'ready' | 'failed';

export interface UseRendererResult {
    /** Attach to the element the canvas should fill. */
    containerRef: React.RefObject<HTMLDivElement | null>;
    /** `null` until the phase is `'ready'`. */
    renderer: IRenderer | null;
    phase: RendererPhase;
    error: Error | null;
}

export interface UseRendererOptions {
    /** Everything but `container`, which the hook supplies from its own ref. */
    init: Omit<RendererInitOptions, 'container'>;
    /**
     * Called once after `init()` resolves, before the first frame — load assets and build the
     * initial scene here. An async return is awaited, and the hook stays `'initializing'` until it
     * settles.
     */
    onReady?: (renderer: IRenderer) => void | Promise<void>;
    /** Called once per animation frame, before `render()`. */
    onFrame?: FrameHandler;
}

/**
 * The largest `dt` a frame may report, in seconds.
 *
 * A backgrounded tab resumes with a multi-second gap; propagating it would teleport every drifter
 * across the stage at once. Clamping makes the sim behave as if the hidden time did not pass,
 * which for a harness is the honest interpretation.
 */
const MAX_FRAME_DT = 1 / 15;

export function useRenderer(options: UseRendererOptions): UseRendererResult {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<IRenderer | null>(null);

    const [phase, setPhase] = useState<RendererPhase>('idle');
    const [error, setError] = useState<Error | null>(null);

    // The callbacks are read through refs so a consumer may pass fresh closures every render
    // without tearing down the GPU context. The effect below therefore depends on NEITHER.
    const onFrameRef = useRef(options.onFrame);
    const onReadyRef = useRef(options.onReady);
    onFrameRef.current = options.onFrame;
    onReadyRef.current = options.onReady;

    // Same reasoning for the init options: they are consumed exactly once, at init, so a caller
    // that inlines the object literal must not thereby re-create the renderer.
    const initRef = useRef(options.init);
    initRef.current = options.init;

    useEffect(() => {
        const container = containerRef.current;
        if (container === null) return;

        const renderer = createPixiRenderer();
        // `cancelled` guards every await below. In StrictMode the effect runs, tears down, and
        // runs again; without this the first pass would keep initializing and then render into a
        // container the second pass already owns.
        let cancelled = false;
        let frame = 0;
        let last = 0;

        // Whether `init()` has settled. Cleanup CANNOT safely destroy before it has: `init()`
        // appends its canvas after an internal `await`, and a `destroy()` arriving in that window
        // finds nothing built yet, no-ops, and then init appends anyway — leaking a live WebGL
        // context into the container. StrictMode's double-mount hits that window every time. So a
        // cancelled-mid-init renderer is destroyed by the init path itself, once it can be.
        let settled = false;

        setPhase('initializing');
        setError(null);

        const loop = (now: number): void => {
            if (cancelled) return;
            frame = requestAnimationFrame(loop);

            // The first frame has no predecessor, so it reports dt 0 rather than the time since
            // the timer origin — which would otherwise be a multi-hundred-ms jump.
            const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_DT);
            last = now;

            onFrameRef.current?.(dt, renderer);
            renderer.render();
        };

        void (async () => {
            try {
                await renderer.init({ ...initRef.current, container });
                settled = true;
                // Unmounted while initializing: the canvas exists now, so tear it down here —
                // cleanup already ran and could not do it.
                if (cancelled) {
                    renderer.destroy();
                    return;
                }

                rendererRef.current = renderer;
                await onReadyRef.current?.(renderer);
                if (cancelled) {
                    renderer.destroy();
                    return;
                }

                setPhase('ready');
                frame = requestAnimationFrame(loop);
            } catch (cause) {
                // A rejected `init()` built nothing, but `onReady` may have thrown after it
                // succeeded — so destroy unconditionally. It is idempotent.
                settled = true;
                renderer.destroy();
                if (cancelled) return;
                setError(cause instanceof Error ? cause : new Error(String(cause)));
                setPhase('failed');
            }
        })();

        return () => {
            cancelled = true;
            if (frame !== 0) cancelAnimationFrame(frame);
            rendererRef.current = null;
            // Only destroy once `init()` has settled — otherwise the canvas it is about to append
            // would outlive this effect. The init path handles the cancelled-mid-init case.
            if (settled) renderer.destroy();
        };
        // Intentionally empty: the renderer outlives every prop, which is what the refs above
        // exist to make safe. A dependency here would tear down the GPU context on a re-render.
    }, []);

    return {
        containerRef,
        renderer: phase === 'ready' ? rendererRef.current : null,
        phase,
        error,
    };
}

/** A stable `dt`-clamping helper, exported so tests can assert the same bound the loop uses. */
export function clampFrameDt(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, MAX_FRAME_DT);
}

/** Reads `phase`/`error` into a single line for the HUD. */
export function describePhase(phase: RendererPhase, error: Error | null): string {
    switch (phase) {
        case 'idle':
            return 'waiting for the container';
        case 'initializing':
            return 'initializing the renderer…';
        case 'ready':
            return 'ready';
        case 'failed':
            return `failed: ${error?.message ?? 'unknown error'}`;
    }
}

/** Convenience re-export so consumers never need a second import for the callback type. */
export type { IRenderer };

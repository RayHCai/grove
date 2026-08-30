// The React <-> IRenderer seam: mount, init, asset load, teardown.
//
// THE RENDERER LIVES IN A REF, NEVER IN STATE. It is a mutable GPU-backed object whose identity
// never changes; putting it in state would re-render every consumer for nothing, and — worse —
// invite React to treat it as a value to be copied. State here carries only what the UI actually
// draws: the load phase and any error.
//
// There is no frame loop here any more. `GameClient` owns the frame and calls `render()` itself, so
// a loop here would present every frame twice; `use-game.ts` is the seam that drives it.

import { useEffect, useRef, useState } from 'react';
import type { IRenderer, RendererInitOptions } from '@platform/renderer';
import { createPixiRenderer } from '@platform/renderer/pixi';

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
     * Called once after `init()` resolves and before the phase turns `'ready'` — load assets here.
     * An async return is awaited, and the hook stays `'initializing'` until it settles.
     */
    onReady?: (renderer: IRenderer) => void | Promise<void>;
}

export function useRenderer(options: UseRendererOptions): UseRendererResult {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<IRenderer | null>(null);

    const [phase, setPhase] = useState<RendererPhase>('idle');
    const [error, setError] = useState<Error | null>(null);

    // Read through a ref so a consumer may pass a fresh closure every render without tearing down
    // the GPU context. The effect below therefore depends on neither it nor the init options.
    const onReadyRef = useRef(options.onReady);
    onReadyRef.current = options.onReady;

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

        // Whether `init()` has settled. Cleanup CANNOT safely destroy before it has: `init()`
        // appends its canvas after an internal `await`, and a `destroy()` arriving in that window
        // finds nothing built yet, no-ops, and then init appends anyway — leaking a live WebGL
        // context into the container. StrictMode's double-mount hits that window every time. So a
        // cancelled-mid-init renderer is destroyed by the init path itself, once it can be.
        let settled = false;

        setPhase('initializing');
        setError(null);

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

                await onReadyRef.current?.(renderer);
                if (cancelled) {
                    renderer.destroy();
                    return;
                }

                rendererRef.current = renderer;
                setPhase('ready');
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

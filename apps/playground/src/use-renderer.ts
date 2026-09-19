// THE RENDERER LIVES IN A REF, NEVER IN STATE: it is a mutable GPU-backed object whose identity
// never changes, and state would re-render every consumer and invite React to copy it.

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

        // Whether `init()` has settled. Cleanup CANNOT destroy before it has: `init()` appends its
        // canvas after an internal `await`, so a `destroy()` in that window no-ops and init appends
        // anyway, leaking a live WebGL context. StrictMode's double-mount hits it every time.
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

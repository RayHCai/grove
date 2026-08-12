// Device capture behind a seam, so a test needs no DOM: the browser adapter is one file under
// `src/browser/` and tests inject a scripted source.

/** Raw device events, before action mapping. */
export type RawInputEvent =
    | { kind: 'key'; code: string; down: boolean }
    | { kind: 'pointer'; button: number; down: boolean; screenX: number; screenY: number }
    | { kind: 'pointerMove'; screenX: number; screenY: number }
    | { kind: 'axis'; code: string; value: number }
    /**
     * Focus left, or a device went away. The client answers it with a release per held code.
     *
     * A browser does not reliably deliver `keyup` when focus leaves — tab switch, alt-tab, an OS modal
     * — and under edges-only the last edge the server saw is a press, so it holds that action and the
     * avatar runs into a wall until the player returns.
     */
    | { kind: 'focusLost' };

/** A source of raw device events. One handler; the returned disposer unregisters it. */
export interface InputDevice {
    onRaw(handler: (event: RawInputEvent) => void): () => void;
    dispose(): void;
}

/** An `InputDevice` that also accepts injected events, for polled devices and tests. */
export interface EmittingInputDevice extends InputDevice {
    emit(event: RawInputEvent): void;
}

/** Drives `GameClient.frame`. `requestAnimationFrame` in a browser, a scripted driver in a test. */
export interface FrameSource {
    start(onFrame: (nowSeconds: number) => void): void;
    stop(): void;
}

/** A frame source a test drives by hand — no rAF, no wall clock. */
export class ManualFrameSource implements FrameSource {
    #onFrame: ((nowSeconds: number) => void) | undefined;

    start(onFrame: (nowSeconds: number) => void): void {
        this.#onFrame = onFrame;
    }

    stop(): void {
        this.#onFrame = undefined;
    }

    /** Runs one frame at `nowSeconds`. A no-op after `stop`. */
    frame(nowSeconds: number): void {
        this.#onFrame?.(nowSeconds);
    }
}

/** A device a test pushes events into. */
export class ScriptedInputDevice implements EmittingInputDevice {
    #handler: ((event: RawInputEvent) => void) | undefined;
    #disposed = false;

    onRaw(handler: (event: RawInputEvent) => void): () => void {
        this.#handler = handler;
        return () => {
            if (this.#handler === handler) this.#handler = undefined;
        };
    }

    dispose(): void {
        this.#disposed = true;
        this.#handler = undefined;
    }

    get disposed(): boolean {
        return this.#disposed;
    }

    emit(event: RawInputEvent): void {
        this.#handler?.(event);
    }
}

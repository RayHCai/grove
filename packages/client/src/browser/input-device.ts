// The DOM input adapter, behind the `./browser` subpath.
//
// Its one non-obvious obligation is the focus-loss sweep: a browser does not reliably deliver `keyup` when
// focus leaves, and under edges-only the last edge the server saw is then a press — so it holds that action
// and the avatar runs into a wall until the player returns.

import type { EmittingInputDevice, RawInputEvent } from '../input.js';

export interface DomInputOptions {
    /** Where pointer events are listened for. Keys are always on `window`. Defaults to `window`. */
    target?: HTMLElement;
}

/**
 * The DOM device. `emit` is part of the surface so a polled device — {@link pollGamepads} — can feed the
 * same handler the listeners feed.
 */
export function createDomInputDevice(opts: DomInputOptions = {}): EmittingInputDevice {
    const target: HTMLElement | Window = opts.target ?? window;
    let handler: ((event: RawInputEvent) => void) | undefined;
    const emit = (event: RawInputEvent): void => handler?.(event);

    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.repeat) return; // auto-repeat is not an edge
        emit({ kind: 'key', code: `keys:${e.code}`, down: true });
    };

    const onKeyUp = (e: KeyboardEvent): void => {
        emit({ kind: 'key', code: `keys:${e.code}`, down: false });
    };

    const onPointerDown = (e: PointerEvent): void => {
        emit({
            kind: 'pointer',
            button: e.button,
            down: true,
            screenX: e.clientX,
            screenY: e.clientY,
        });
    };

    const onPointerUp = (e: PointerEvent): void => {
        emit({
            kind: 'pointer',
            button: e.button,
            down: false,
            screenX: e.clientX,
            screenY: e.clientY,
        });
    };

    const onPointerMove = (e: PointerEvent): void => {
        emit({ kind: 'pointerMove', screenX: e.clientX, screenY: e.clientY });
    };

    /**
     * One event rather than a release per code: the binding table holds the authoritative held set — a code
     * bound in one context and released in another must still release — so it does the sweep.
     */
    const onFocusLost = (): void => {
        emit({ kind: 'focusLost' });
    };

    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') onFocusLost();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onFocusLost);
    document.addEventListener('visibilitychange', onVisibilityChange);
    target.addEventListener('pointerdown', onPointerDown as EventListener);
    target.addEventListener('pointerup', onPointerUp as EventListener);
    target.addEventListener('pointermove', onPointerMove as EventListener);
    // A held button whose pointer leaves is a release the browser may never deliver either.
    target.addEventListener('pointerleave', onFocusLost);
    window.addEventListener('gamepaddisconnected', onFocusLost);

    return {
        onRaw(next: (event: RawInputEvent) => void): () => void {
            handler = next;
            return () => {
                if (handler === next) handler = undefined;
            };
        },

        emit,

        dispose(): void {
            handler = undefined;
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onFocusLost);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            target.removeEventListener('pointerdown', onPointerDown as EventListener);
            target.removeEventListener('pointerup', onPointerUp as EventListener);
            target.removeEventListener('pointermove', onPointerMove as EventListener);
            target.removeEventListener('pointerleave', onFocusLost);
            window.removeEventListener('gamepaddisconnected', onFocusLost);
        },
    };
}

/** Per-pad last-seen axis and button state, so a poll emits transitions rather than everything. */
interface PadState {
    axes: number[];
    buttons: boolean[];
}

/** The default poll state, for the common case of one poller per page. */
const gamepadState = new Map<number, PadState>();

/**
 * Polls connected gamepads and emits only what changed since the last call.
 *
 * The Gamepad API has no event for axis motion, so a poll is the only way to read a stick — but a pad
 * reports ~20 axes and buttons, and emitting all of them every frame would run binding resolution 1200
 * times a second to discover nothing moved.
 */
export function pollGamepads(
    device: { emit(event: RawInputEvent): void },
    state: Map<number, PadState> = gamepadState,
): void {
    for (const pad of navigator.getGamepads()) {
        if (pad === null) continue;
        let last = state.get(pad.index);
        if (last === undefined) {
            last = { axes: [], buttons: [] };
            state.set(pad.index, last);
        }

        for (const [index, value] of pad.axes.entries()) {
            if (last.axes[index] === value) continue;
            last.axes[index] = value;
            device.emit({ kind: 'axis', code: `gamepad:axis${index}`, value });
        }
        for (const [index, button] of pad.buttons.entries()) {
            if (last.buttons[index] === button.pressed) continue;
            last.buttons[index] = button.pressed;
            device.emit({
                kind: 'key',
                code: `gamepad:button${index}`,
                down: button.pressed,
            });
        }
    }
}

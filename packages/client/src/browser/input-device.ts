// The focus-loss sweep is the non-obvious part: browsers drop `keyup` when focus leaves, so under
// edges-only the server's last edge stays a press and the avatar runs into a wall.

import type { EmittingInputDevice, RawInputEvent } from '../input.js';

export interface DomInputOptions {
    /** Where pointer events are listened for. Keys are always on `window`. Defaults to `window`. */
    target?: HTMLElement;
}

/** The DOM device; `emit` is public so {@link pollGamepads} feeds the same handler. */
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

    /** One event, not a release per code: the binding table holds the authoritative held set. */
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

/** Polls connected gamepads and emits only what changed; the API has no axis event. */
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

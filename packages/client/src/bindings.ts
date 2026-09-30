import { AXIS_QUANTUM } from './constants.js';
import type { RawInputEvent } from './input.js';
import type { InputPhase } from '@platform/protocol';

/** One resolved action edge, before it is framed for the wire. */
export interface ResolvedEdge {
    action: string;
    on: InputPhase;
    value?: number;
}

/** `'button'` is a press/release pair; `'axis'` carries a magnitude, ±1 for a key pair. */
export type Binding =
    | { kind: 'button'; code: string; action: string }
    | { kind: 'axis'; code: string; action: string; polarity?: number }
    /** The cursor's world position, as an axis pair. */
    | { kind: 'cursorX'; action: string }
    | { kind: 'cursorY'; action: string };

/** The viewport extent the cursor axes quantize against, read from the renderer each frame. */
export interface ViewportExtent {
    width: number;
    height: number;
}

/** A fixed binding table; quantizer state is per action, so bindings share a deadband. */
export class BindingTable {
    readonly #bindings: readonly Binding[];
    /** Last value sent per action, so a change is measured against the wire and not the device. */
    readonly #lastSent = new Map<string, number>();
    /** Codes currently down, so `focusLost` can synthesize a release for each. */
    readonly #down = new Set<string>();

    constructor(bindings: readonly Binding[] = []) {
        this.#bindings = [...bindings];
    }

    /** Device codes currently held: what a synthetic release sweep iterates. */
    heldCodes(): string[] {
        return [...this.#down];
    }

    /** Resolves one raw event to action edges; `viewport` sizes the cursor quantum. */
    resolve(
        event: RawInputEvent,
        viewport: ViewportExtent,
        out: ResolvedEdge[] = [],
    ): ResolvedEdge[] {
        out.length = 0;

        switch (event.kind) {
            case 'key':
                this.#button(event.code, event.down, out);
                return out;

            case 'pointer':
                this.#button(`mouse:${event.button}`, event.down, out);
                this.#cursor(event.screenX, event.screenY, viewport, out);
                return out;

            case 'pointerMove':
                this.#cursor(event.screenX, event.screenY, viewport, out);
                return out;

            case 'axis':
                for (const b of this.#bindings) {
                    if (b.kind !== 'axis' || b.code !== event.code) continue;
                    this.#axis(b.action, event.value * (b.polarity ?? 1), AXIS_QUANTUM, out);
                }
                return out;

            case 'focusLost':
                // Snapshotted first, because `#button` deletes from `#down` as it goes.
                for (const code of this.heldCodes()) this.#button(code, false, out);
                return out;
        }
    }

    #button(code: string, down: boolean, out: ResolvedEdge[]): void {
        if (down) {
            if (this.#down.has(code)) return; // auto-repeat is not an edge
            this.#down.add(code);
        } else {
            if (!this.#down.has(code)) return;
            this.#down.delete(code);
        }

        for (const b of this.#bindings) {
            if (b.kind === 'button' && b.code === code) {
                out.push({ action: b.action, on: down ? 'press' : 'release' });
                continue;
            }
            // A key as an axis half: through the axis path, so the wire sees one value per action.
            if (b.kind === 'axis' && b.code === code) {
                this.#axis(b.action, down ? (b.polarity ?? 1) : 0, AXIS_QUANTUM, out);
            }
        }
    }

    #cursor(screenX: number, screenY: number, viewport: ViewportExtent, out: ResolvedEdge[]): void {
        for (const b of this.#bindings) {
            if (b.kind === 'cursorX') {
                this.#axis(b.action, screenX, AXIS_QUANTUM * Math.abs(viewport.width), out);
            } else if (b.kind === 'cursorY') {
                this.#axis(b.action, screenY, AXIS_QUANTUM * Math.abs(viewport.height), out);
            }
        }
    }

    /** Sent when it changes past `quantum`; a return to neutral always sends, unquantized. */
    #axis(action: string, value: number, quantum: number, out: ResolvedEdge[]): void {
        const last = this.#lastSent.get(action);
        const neutral = value === 0;
        if (last !== undefined && !neutral && Math.abs(value - last) < quantum) return;
        if (last === undefined && neutral) return;
        if (last === 0 && neutral) return;
        this.#lastSent.set(action, value);
        out.push({ action, on: 'hold', value });
    }

    /** Forgets what was sent, keeping held codes (the resync case); `#down` is device truth. */
    forgetSentValues(): void {
        this.#lastSent.clear();
    }
}

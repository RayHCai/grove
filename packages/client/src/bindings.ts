// Device → action mapping. Pure and table-driven, so it takes fixed-vector tests.
//
// Actions are the network protocol: clients send `{player, action, value}`, not keycodes. Bindings are per
// player, because local co-op needs separate sets.

import { AXIS_QUANTUM } from './constants.js';
import type { RawInputEvent } from './input.js';
import type { InputPhase } from '@platform/protocol';

/** One resolved action edge, before it is framed for the wire. */
export interface ResolvedEdge {
    action: string;
    on: InputPhase;
    value?: number;
}

/** `'button'` is a press/release pair; `'axis'` carries a magnitude, ±1 for a key pair via `polarity`. */
export type Binding =
    | { kind: 'button'; code: string; action: string; context?: string }
    | { kind: 'axis'; code: string; action: string; polarity?: number; context?: string }
    /** The cursor's world position, as an axis pair. */
    | { kind: 'cursorX'; action: string; context?: string }
    | { kind: 'cursorY'; action: string; context?: string };

/** The viewport extent the cursor axes quantize against — read from the renderer each frame. */
export interface ViewportExtent {
    width: number;
    height: number;
}

/**
 * A per-player binding table, plus the quantizer state an axis needs to send only on change.
 *
 * The quantizer is per action, not per binding: two bindings driving one axis must not each get a deadband.
 */
export class BindingTable {
    readonly #bindings: Binding[] = [];
    /** Last value sent per action, so a change is measured against the wire and not the device. */
    readonly #lastSent = new Map<string, number>();
    /** Codes currently down, so `focusLost` can synthesize a release for each. */
    readonly #down = new Set<string>();
    #context = 'gameplay';
    /** Rebuilt on change, because filtering per event allocates twice per pointer move. */
    #active: Binding[] = [];
    #activeStale = true;

    constructor(bindings: readonly Binding[] = []) {
        this.#bindings.push(...bindings);
    }

    setContext(context: string): void {
        if (this.#context === context) return;
        this.#context = context;
        this.#activeStale = true;
    }

    get context(): string {
        return this.#context;
    }

    add(binding: Binding): void {
        this.#bindings.push(binding);
        this.#activeStale = true;
    }

    /**
     * Rebinds an action to a set of button codes, dropping its previous button bindings.
     *
     * Buttons only: a blanket delete would silently take away the gamepad axis driving the same action.
     */
    rebind(action: string, codes: readonly string[]): void {
        for (let i = this.#bindings.length - 1; i >= 0; i--) {
            const b = this.#bindings[i];
            if (b?.kind === 'button' && b.action === action) this.#bindings.splice(i, 1);
        }
        for (const code of codes) this.#bindings.push({ kind: 'button', code, action });
        this.#activeStale = true;
    }

    /** Device codes currently held — what a synthetic release sweep iterates. */
    heldCodes(): string[] {
        return [...this.#down];
    }

    /**
     * Resolves one raw event to zero or more action edges.
     *
     * `viewport` sizes the cursor quantum against the current extent rather than a fixed world-px step, so
     * wire volume does not change when the camera zooms out.
     */
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
                for (const b of this.#activeBindings()) {
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
        // Tracked regardless of context, so a switch while a key is held still yields its release.
        if (down) {
            if (this.#down.has(code)) return; // auto-repeat is not an edge
            this.#down.add(code);
        } else {
            if (!this.#down.has(code)) return;
            this.#down.delete(code);
        }

        for (const b of this.#activeBindings()) {
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
        for (const b of this.#activeBindings()) {
            if (b.kind === 'cursorX') {
                this.#axis(b.action, screenX, AXIS_QUANTUM * Math.abs(viewport.width), out);
            } else if (b.kind === 'cursorY') {
                this.#axis(b.action, screenY, AXIS_QUANTUM * Math.abs(viewport.height), out);
            }
        }
    }

    /**
     * Sent when it changes past `quantum`, so analog jitter is not an action per tick.
     *
     * A return to neutral always sends, unquantized: otherwise a stick released just inside the deadband
     * leaves the server holding a small permanent deflection.
     */
    #axis(action: string, value: number, quantum: number, out: ResolvedEdge[]): void {
        const last = this.#lastSent.get(action);
        const neutral = value === 0;
        if (last !== undefined && !neutral && Math.abs(value - last) < quantum) return;
        if (last === undefined && neutral) return;
        if (last === 0 && neutral) return;
        this.#lastSent.set(action, value);
        out.push({ action, on: 'hold', value });
    }

    /** Rebuilds both, for a host that knows the device state is no longer trustworthy. */
    reset(): void {
        this.#lastSent.clear();
        this.#down.clear();
    }

    /**
     * Forgets what was sent, keeping the held-code set — the resync case.
     *
     * The quantizer must stop suppressing values the server no longer has, or a still-deflected stick is
     * never reported again. `#down` survives because it is device truth: clearing it would swallow the
     * release edge for every key held across the resync.
     */
    forgetSentValues(): void {
        this.#lastSent.clear();
    }

    #activeBindings(): readonly Binding[] {
        if (this.#activeStale) {
            this.#active = this.#bindings.filter(
                (b) => b.context === undefined || b.context === this.#context,
            );
            this.#activeStale = false;
        }
        return this.#active;
    }
}

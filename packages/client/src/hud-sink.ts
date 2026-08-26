// The real implementation of core's HUD seam. Core owns the authored state and pushes what changed;
// this holds it in the shape a UI layer reads and tells that layer when to look again.
//
// No DOM: a HUD is a panel-authored layout the host draws, and which framework draws it is the
// host's business. This is the boundary those two meet at.

import type { HUDSink, HUDWidgetState } from '@platform/core';

/** One widget under its name — the map entry flattened, for a layer that renders a list. */
export type HUDWidgetView = HUDWidgetState & { name: string };

export class ClientHUDSink implements HUDSink {
    readonly #widgets = new Map<string, HUDWidgetState>();
    /** Open screens bottom to top, mirroring the order core opened them in. */
    readonly #open: string[] = [];
    readonly #listeners = new Set<() => void>();

    widget(name: string, state: Readonly<HUDWidgetState>): void {
        // Copied, so a reader holds a value core's next write cannot change under it. Shallow, which
        // keeps a bound `Countdown` the live object it has to be — the whole point of a timer widget.
        this.#widgets.set(name, { ...state });
        this.#notify();
    }

    screen(name: string, visible: boolean): void {
        const at = this.#open.indexOf(name);
        if (visible && at < 0) this.#open.push(name);
        else if (!visible && at >= 0) this.#open.splice(at, 1);
        else return; // idempotent on both sides, so a repeat is not a redraw
        this.#notify();
    }

    /** Every widget code has written, in first-write order. */
    get widgets(): HUDWidgetView[] {
        return [...this.#widgets].map(([name, state]) => ({ name, ...state }));
    }

    /** Open screen names, bottom to top. */
    get openScreens(): string[] {
        return [...this.#open];
    }

    widgetOf(name: string): Readonly<HUDWidgetState> | null {
        return this.#widgets.get(name) ?? null;
    }

    /** Subscribes to changes; the returned function unsubscribes. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Drops every widget and screen — a resync builds a new world, and this belongs to the old one. */
    clear(): void {
        this.#widgets.clear();
        this.#open.length = 0;
        this.#notify();
    }

    // Contained, so a UI bug cannot unwind into the handler that wrote the widget.
    #notify(): void {
        for (const listener of this.#listeners) {
            try {
                listener();
            } catch {
                // A listener's throw is the listener's problem; the HUD state is already correct.
            }
        }
    }
}

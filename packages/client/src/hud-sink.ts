// The real implementation of core's HUD seam. Core owns the authored state and pushes what changed;
// this holds it in the shape a UI layer reads and tells that layer when to look again.
//
// No DOM: a HUD is a panel-authored layout the host draws, and which framework draws it is the
// host's business. This is the boundary those two meet at.

import type { HUDSink, HUDWidgetState } from '@platform/core';

/** One widget under its name — the map entry flattened, for a layer that renders a list. */
export type HUDWidgetView = HUDWidgetState & { name: string };

/**
 * Whether two widget records say the same thing.
 *
 * Field by field over the six a record holds, because a shallow spread compares by reference and a
 * `Countdown` is a live object whose IDENTITY is what matters — a timer bound to the same countdown
 * has not changed, and rebinding it to a different one has.
 */
function same(a: Readonly<HUDWidgetState>, b: Readonly<HUDWidgetState>): boolean {
    return (
        a.text === b.text &&
        a.number === b.number &&
        a.fraction === b.fraction &&
        a.icon === b.icon &&
        a.countdown === b.countdown &&
        a.visible === b.visible &&
        a.enabled === b.enabled
    );
}

export class ClientHUDSink implements HUDSink {
    readonly #widgets = new Map<string, HUDWidgetState>();
    /** Open screens bottom to top, mirroring the order core opened them in. */
    readonly #open: string[] = [];
    readonly #listeners = new Set<() => void>();

    widget(name: string, state: Readonly<HUDWidgetState>): void {
        // Unchanged is not a redraw. A `ClientScript`'s `@onUpdate` runs at DISPLAY rate and the
        // authored pattern is to write every widget every frame, so without this a HUD that says
        // the same thing all round still re-renders its host sixty times a second. The comparison
        // is against the copy below rather than `state`, which core mutates in place — the record
        // handed over is the same object each time, so it always equals itself.
        const held = this.#widgets.get(name);
        if (held !== undefined && same(held, state)) return;
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
        const out: HUDWidgetView[] = [];
        for (const [name, state] of this.#widgets) out.push({ name, ...state });
        return out;
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

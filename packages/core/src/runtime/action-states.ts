// Pure — no runtime, no dispatch — so both endpoints fold input edges through one implementation
// of the one-tick-wide pressed/released rule, and a second would diverge as a prediction mismatch.

import type { EventPhase } from '../script/types.js';
import type { ActionState } from './player.js';

/** One action's edge on one tick — the fold's input, structurally the wire's `InputAction`. */
export interface InputEdge {
    action: string;
    on: EventPhase;
    /** Axis magnitude or hold sample. Absent for a plain press/release. */
    value?: number;
}

/**
 * A mutable {@link ActionState}, folded forward one edge and one tick at a time.
 *
 * `held` and `axis` persist across ticks; `pressed` and `released` are one tick wide.
 */
export interface ActionStates extends ActionState {
    /** A press sets held + pressed; a release clears held and sets released; an axis updates value. */
    applyEdge(edge: InputEdge): void;
    /** Clears `pressed` / `released`, keeps `held` and axis values — the one-tick-wide edge rule. */
    advanceTick(): void;
    /** Every action currently held, for the client's horizon re-derivation. */
    heldActions(): string[];
    /** Every non-neutral axis and its value, same purpose. */
    axisValues(): Array<{ action: string; value: number }>;
}

/**
 * A fresh action-state map, everything neutral.
 *
 * `press` and `release` also write the axis: a bound button reads as 1 while held and 0 once
 * released, so a movement type filling `intent` from an axis works whether the binding is a stick
 * or a key. An explicit `value` on the edge wins, which is what carries a stick's magnitude.
 */
export function createActionStates(): ActionStates {
    const held = new Set<string>();
    const pressed = new Set<string>();
    const released = new Set<string>();
    const axis = new Map<string, number>();

    return {
        held: (action) => held.has(action),
        pressed: (action) => pressed.has(action),
        released: (action) => released.has(action),
        axis: (action) => axis.get(action) ?? 0,

        applyEdge(edge: InputEdge): void {
            switch (edge.on) {
                case 'press':
                    held.add(edge.action);
                    pressed.add(edge.action);
                    axis.set(edge.action, edge.value ?? 1);
                    break;
                case 'release':
                    held.delete(edge.action);
                    released.add(edge.action);
                    axis.set(edge.action, edge.value ?? 0);
                    break;
                case 'hold':
                    // A hold sample carries a value and asserts nothing about the edge: it must not
                    // set `pressed`, which is one tick wide by definition, and it must not add to
                    // `held` on its own — an axis returning to neutral is a hold, not a release.
                    if (edge.value !== undefined) axis.set(edge.action, edge.value);
                    break;
            }
        },

        advanceTick(): void {
            pressed.clear();
            released.clear();
        },

        heldActions: () => [...held],

        axisValues: () =>
            [...axis.entries()]
                .filter(([, value]) => value !== 0)
                .map(([action, value]) => ({ action, value })),
    };
}

// The one script in this game that runs ONLY in a browser.
//
// A screen host is a `ClientScript` by necessity — `ServerScript<HUDScreen>` is a load-time error,
// because a screen exists on one machine.

import type { HUDScreen } from '@platform/engine';
import { ClientScript, game, hud, onPress, onStart, onUpdate } from '@platform/engine';
import { STATE_SWEEPS, STATE_TAKEN, WIDGET_SCORE, WIDGET_SWEEP } from '../globals.js';

/** What the button says at rest, and after a press this client has sent but not seen answered. */
export const SWEEP_LABEL = 'sweep';
export const ASKED_LABEL = 'asked';

/**
 * Reading a `@serverState` field by name, on a client.
 *
 * The value lives on the host RECORD and the mirror hoists an accessor onto the facade as each diff
 * lands. What neither end can do is TYPE it: `Player` and `Game` declare no such member, and the
 * script that does never attached here.
 */
function readState<T>(host: object | null | undefined, field: string): T | undefined {
    if (host === null || host === undefined) return undefined;
    return (host as Record<string, unknown>)[field] as T | undefined;
}

export class Panel extends ClientScript<HUDScreen> {
    /** The count this screen has already drawn, so the authority's answer is told from a redraw. */
    #shownSweeps = -1;

    /** Runs inside `hud.open` rather than a tick later: a screen that did nothing reads as a dropped frame. */
    @onStart
    show(): void {
        hud.text(WIDGET_SWEEP, SWEEP_LABEL);
        hud.enable(WIDGET_SWEEP);
        hud.show(WIDGET_SWEEP);
    }

    /**
     * It says "asked", never "done": the authority decides, and the next replicated count corrects
     * the label below.
     */
    @onPress(WIDGET_SWEEP)
    asked(): void {
        hud.text(WIDGET_SWEEP, ASKED_LABEL);
    }

    @onUpdate
    render(): void {
        hud.number(WIDGET_SCORE, readState<number>(this.localPlayer, STATE_TAKEN) ?? 0);
        const sweeps = readState<number>(game, STATE_SWEEPS) ?? 0;
        // Only on a change, so an optimistic label survives until the answer it is standing in for
        // actually lands.
        if (sweeps === this.#shownSweeps) return;
        this.#shownSweeps = sweeps;
        hud.text(WIDGET_SWEEP, sweeps === 0 ? SWEEP_LABEL : `${SWEEP_LABEL} ${sweeps}`);
    }
}

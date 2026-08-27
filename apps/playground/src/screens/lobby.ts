// The one class in this app that runs ONLY in a browser.
//
// A screen host is a `ClientScript` by necessity — `ServerScript<HUDScreen>` is a load-time error,
// because a screen exists on one machine — and it is what makes a widget press local before it is
// authoritative: the button answers on the frame it was pressed, and the round only starts when the
// server agrees.
//
// It is compiled by `tsconfig.server.json` like everything else carrying decorators, and the browser
// imports the lowered `dist/screens/lobby.js` — `dist/client` is Vite's, and `emptyOutDir` empties
// whatever it is aimed at. That project has no DOM lib, which is the compiler stating the rule this
// file has to follow anyway: a screen script writes widgets, never elements.

import { ClientScript, hud, onEnd, onPress, onStart } from '@platform/core';
import type { HUDScreen } from '@platform/core';
import { WIDGET_READY } from '../shared.js';

/** What the button says before and after a press this client has sent but not seen answered. */
const READY_LABEL = 'ready up';
const ASKED_LABEL = 'waiting for the others…';

/**
 * The lobby screen: the ready button's local half.
 *
 * `@onStart` runs on the same call that opened the screen rather than a tick later — `hud.open`
 * drops the pending start and dispatches immediately, because a menu that appeared and did nothing
 * until the next tick reads as a dropped frame.
 */
export class LobbyScreen extends ClientScript<HUDScreen> {
    @onStart
    show(): void {
        hud.text(WIDGET_READY, READY_LABEL);
        hud.enable(WIDGET_READY);
        hud.show(WIDGET_READY);
    }

    /**
     * Scoped to this screen's own widgets: a screen-hosted handler answers only presses naming its
     * own screen, which is what keeps two menus with a `back` button from colliding.
     *
     * It says "asked", never "granted". The authority decides whether the round starts, and the
     * label is corrected by the bridge on the next replicated `readyCount`.
     */
    @onPress(WIDGET_READY)
    asked(): void {
        hud.text(WIDGET_READY, ASKED_LABEL);
        hud.disable(WIDGET_READY);
    }

    @onEnd
    hide(): void {
        hud.hide(WIDGET_READY);
    }
}

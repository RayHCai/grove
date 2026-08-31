// The lobby screen: the one script in this game that runs ONLY in a browser.
//
// A screen host is a `ClientScript` by necessity — `ServerScript<HUDScreen>` is a load-time error,
// because a screen exists on one machine.

import type { HUDScreen } from '@platform/engine';
import { ClientScript, hud, onEnd, onPress, onStart } from '@platform/engine';
import { WIDGET_READY } from '../globals.js';

/** What the button says before, and after, a press this client has sent but not seen answered. */
const READY_LABEL = 'ready up';
const ASKED_LABEL = 'waiting for the others…';

export class LobbyScreen extends ClientScript<HUDScreen> {
    /** Runs inside `hud.open` rather than a tick later: a menu that did nothing reads as a dropped frame. */
    @onStart
    show(): void {
        hud.text(WIDGET_READY, READY_LABEL);
        hud.enable(WIDGET_READY);
        hud.show(WIDGET_READY);
    }

    /**
     * Scoped to this screen's own widgets, which keeps two menus with a `back` button from colliding.
     *
     * It says "asked", never "granted": the authority decides, and the next replicated `readyCount`
     * corrects the label.
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

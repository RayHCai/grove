// A screen host must be a `ClientScript`: `ServerScript<HUDScreen>` is a load-time error.

import type { HUDScreen } from '@platform/engine';
import { ClientScript, hud, onEnd, onPress, onStart } from '@platform/engine';
import { WIDGET_READY } from '../globals.js';

/** What the button says before, and after, a press this client has sent but not seen answered. */
const READY_LABEL = 'ready up';
const ASKED_LABEL = 'waiting for the others…';

export class LobbyScreen extends ClientScript<HUDScreen> {
    /** Runs inside `hud.open`, not a tick later: a menu doing nothing reads as a dropped frame. */
    @onStart
    show(): void {
        hud.text(WIDGET_READY, READY_LABEL);
        hud.enable(WIDGET_READY);
        hud.show(WIDGET_READY);
    }

    /**
     * Scoped to this screen's own widgets, which keeps two menus with a `back` button apart.
     * It says "asked", never "granted": the next replicated `readyCount` corrects the label.
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

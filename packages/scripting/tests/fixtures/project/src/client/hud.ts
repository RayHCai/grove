import { ClientScript, onStart } from '@platform/core';
import type { HUDScreen } from '@platform/core';

/** A client script may read the wall clock: it draws, and nothing replays it. */
export class Clock extends ClientScript<HUDScreen> {
    startedAt = 0;

    @onStart
    begin(): void {
        this.startedAt = Date.now();
    }
}

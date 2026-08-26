import { ServerScript, onPlayerJoin } from '@platform/core';
import type { Ctx, Game } from '@platform/core';
import { SPEED } from '../shared.js';

/** The authority's own, and it must not reach the client chunk. */
export class Rules extends ServerScript<Game> {
    joined = 0;

    @onPlayerJoin
    welcome(_ctx: Ctx): void {
        this.joined += SPEED;
    }
}

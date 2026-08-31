// Attached to every Player at the join: it turns that player's input into world changes.
//
// Input reaches a player host and an avatar host, never the Game host — which is why this is
// per-player rather than a handler on `Rules`.

import type { Ctx, Player } from '@platform/engine';
import { ServerScript, game, onEvent, onEventHold, onUpdate } from '@platform/engine';
import { ACTION_AIM_Y, ACTION_CLEAR, ACTION_SPAWN, decodeAim } from '../globals.js';
import { Rules } from '../game/rules.js';
import { slotOf } from '../game/slots.js';
import { liveLeaves, spawnLeaf } from '../templates/leaf/leaf.js';

/**
 * The work happens on the update pass rather than in the press handler because a press is
 * dispatched before that tick's axis samples are, so the click's y is only current one pass later.
 */
export class Clicker extends ServerScript<Player> {
    #aimY = 0;
    #pending = 0;
    #clearing = false;

    @onEventHold(ACTION_AIM_Y)
    aim(ctx: Ctx): void {
        const value = ctx.value;
        if (value === undefined) return;
        this.#aimY = decodeAim(value);
    }

    @onEvent(ACTION_SPAWN)
    click(): void {
        this.#pending += 1;
    }

    @onEvent(ACTION_CLEAR)
    clear(): void {
        this.#clearing = true;
    }

    /**
     * Planting is a LOBBY affordance. During a round the leaves are the round's to drop, and a tab
     * that could conjure its own would be scoring against a supply nobody else had.
     */
    @onUpdate
    apply(): void {
        const rules = game.getScript(Rules);
        if (rules === null) return;
        const lobby = rules.phase === 'lobby';

        if (this.#clearing) {
            this.#clearing = false;
            if (lobby) for (const leaf of liveLeaves(game)) leaf.destroy();
        }

        while (this.#pending > 0) {
            this.#pending -= 1;
            if (lobby) spawnLeaf(game, this.#aimY, slotOf(this.host));
        }
    }
}

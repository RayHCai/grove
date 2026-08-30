// Attached to every Player at the join: it turns that player's input into world changes.
//
// Input reaches a player host and an avatar host, never the Game host — which is why this is
// per-player rather than a handler on `Rules`.

import type { Ctx, Player } from '@platform/engine';
import { ServerScript, onEvent, onEventHold, onUpdate } from '@platform/engine';
import {
    ACTION_AIM_Y,
    ACTION_CLEAR,
    ACTION_SPAWN,
    STATE_SLOT,
    decodeAim,
    tintSlot,
} from '../globals.js';
import { currentRules } from '../session.js';
import { readState } from '../state.js';
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
        const rules = currentRules();
        if (rules === null) return;
        const game = rules.host;
        const lobby = rules.phase === 'lobby';

        if (this.#clearing) {
            this.#clearing = false;
            if (lobby) for (const leaf of liveLeaves(game)) leaf.destroy();
        }

        while (this.#pending > 0) {
            this.#pending -= 1;
            if (lobby) spawnLeaf(game, this.#aimY, this.#slot());
        }
    }

    /** This player's palette seat, which is the colour anything they plant is badged with. */
    #slot(): number {
        const held = readState(this.host, STATE_SLOT);
        return tintSlot(typeof held === 'number' ? held : 0);
    }
}

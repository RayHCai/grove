// A world built to make the client guess wrong.
//
// Prediction is only half the contract: the other half is what happens when the authority disagrees
// with what a tab already drew. The client either EASES the difference away or, past a threshold,
// snaps — and which branch it takes is a decision no suite driving the real server has ever made it
// take, because a well-behaved game never disagrees.
//
// So this one disagrees on purpose. `Drift` is synced and is what a tab predicts; `Hand` is
// server-located, which is exactly why a displacement it makes is unpredictable — the class does
// not exist in the mirror, so no amount of replay can arrive at the same answer.

import type { Ctx, Entity, Game } from '@platform/engine';
import { ServerScript, SyncedScript, onEventHold, onPlayerJoin, onPress } from '@platform/engine';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_DRIFT = 'drift';
export const SCRIPT_HAND = 'hand';

export const ACTION_PUSH = 'push';
export const CODE_PUSH = 'KeyD';

/** Wide, because the hurl below has to clear the snap threshold without leaving the world. */
export const WIDE = { left: -2000, right: 2000, top: 1200, bottom: -1200 };

export const START = { x: 0, y: 0 };

/** World units a held tick moves an avatar, on both ends. */
export const STEP = 2;

/**
 * The two displacements, either side of the client's snap threshold.
 *
 * The threshold is 64 units, compared squared. A nudge has to be small enough to ease and large
 * enough that a test can tell it happened; a hurl has to be past it with no argument.
 */
export const NUDGE = 40;
export const HURL = 600;

export const W = {
    nudge: 'nudge',
    hurl: 'hurl',
} as const;

/** Synced, so a tab holds a copy and predicts with it — the only reason a mispredict is possible. */
export class Drift extends SyncedScript<Entity> {
    @onEventHold(ACTION_PUSH)
    push(): void {
        const at = this.host.position;
        this.host.setPosition(at.x + STEP, at.y);
    }
}

/**
 * Server-located, and that is the whole design: a mirror never holds this class, so a tab cannot
 * replay what it did and has to be corrected into agreeing.
 */
export class Hand extends ServerScript<Game> {
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(START.x, START.y);
    }

    @onPress(W.nudge)
    doNudge(ctx: Ctx): void {
        this.#shove(ctx, NUDGE);
    }

    @onPress(W.hurl)
    doHurl(ctx: Ctx): void {
        this.#shove(ctx, HURL);
    }

    #shove(ctx: Ctx, by: number): void {
        const player = ctx.player;
        if (!player || !player.hasAvatar) return;
        const at = player.avatar.position;
        player.avatar.setPosition(at.x + by, at.y);
    }
}

export const CORRECTION_WORLD: World = defineWorld({
    id: 'correction',
    bounds: WIDE,
    assets: [DISC_ASSET],
    bindings: [{ kind: 'button', code: CODE_PUSH, action: ACTION_PUSH }],
    scripts: [
        {
            id: SCRIPT_HAND,
            export: 'Hand',
            path: 'src/worlds/correction.ts',
            location: 'server',
            host: 'game',
            ctor: Hand,
        },
        {
            id: SCRIPT_DRIFT,
            export: 'Drift',
            path: 'src/worlds/correction.ts',
            location: 'synced',
            host: 'entity',
            ctor: Drift,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR, [attach(SCRIPT_DRIFT)])],
    gameScripts: [attach(SCRIPT_HAND)],
});

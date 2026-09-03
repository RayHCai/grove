// The avatar's reach: what turns walking into collecting.

import type { Ctx, Entity } from '@platform/engine';
import { ServerScript, game, onCollide, onStart } from '@platform/engine';
import { AVATAR_HALF, TAG_ORB } from '../globals.js';
import { Orb } from './orb.js';
import { Ledger } from './ledger.js';

/**
 * On every avatar, from the template.
 *
 * `@onCollide` is the ENTER edge of an overlap and fires once per tag on the other body, so an orb
 * walked into scores once however many ticks the two stay touching.
 */
export class Collector extends ServerScript<Entity> {
    @onStart
    equip(): void {
        this.host.collider = {
            enabled: true,
            isTrigger: true,
            bounds: {
                left: -AVATAR_HALF,
                right: AVATAR_HALF,
                top: AVATAR_HALF,
                bottom: -AVATAR_HALF,
            },
        };
    }

    @onCollide(TAG_ORB)
    take(ctx: Ctx): void {
        const orb = ctx.other;
        const player = this.host.owner;
        // Two avatars can reach one orb on the same tick and both handlers run: the liveness check
        // is what stops the second one scoring an orb the first already took.
        if (!orb || !orb.alive || player === null) return;
        game.getScript(Ledger)?.award(player, orb.getScript(Orb)?.value ?? 0);
        orb.destroy();
    }
}

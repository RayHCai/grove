// The `player` template's reach: what turns walking into harvesting.

import type { Ctx, Entity } from '@platform/engine';
import { ServerScript, game, onCollide, onStart } from '@platform/engine';
import { AVATAR_HALF, LEAF_TAG } from '../../globals.js';
import { Rules } from '../../game/rules.js';
import { slotOf } from '../../game/slots.js';
import { Leaf, harvestValue } from '../leaf/leaf.js';

/**
 * On every avatar, from the Player template.
 *
 * `@onCollide` is the ENTER edge of an overlap and fires once per tag on the other body, so a leaf
 * walked into scores once however many ticks the two stay touching.
 */
export class Harvester extends ServerScript<Entity> {
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

    @onCollide(LEAF_TAG)
    pick(ctx: Ctx): void {
        const leaf = ctx.other;
        const rules = game.getScript(Rules);
        const player = this.host.owner;
        // Two avatars can reach one leaf on the same tick and both handlers run: the liveness check
        // is what stops the second one scoring a leaf the first already took.
        if (!leaf || !leaf.alive || rules === null || player === null) return;

        const state = leaf.getScript(Leaf);
        rules.award(
            player,
            harvestValue({
                ripe: state?.ripe === true,
                badgedForHarvester: state?.badgeSlot === slotOf(player),
            }),
        );
        leaf.destroy();
    }
}

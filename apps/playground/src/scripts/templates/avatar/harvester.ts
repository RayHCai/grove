// The `player` template's reach: what turns walking into harvesting.

import type { Ctx, Entity } from '@platform/engine';
import { ServerScript, onCollide, onStart } from '@platform/engine';
import {
    AVATAR_HALF,
    LEAF_TAG,
    STATE_BADGE_SLOT,
    STATE_RIPE,
    STATE_SLOT,
    tintSlot,
} from '../../globals.js';
import { currentRules } from '../../session.js';
import { readState } from '../../state.js';
import { harvestValue } from '../leaf/leaf.js';

/**
 * On every avatar, from the Player template.
 *
 * `@onCollide` is the ENTER edge of an overlap and fires once per tag on the other body, so a leaf
 * walked into scores once however many ticks the two stay touching.
 */
export class Harvester extends ServerScript<Entity> {
    @onStart
    equip(): void {
        // The engine's `Bounds` is four numbers, so a collider is a literal — there is nothing to
        // construct and nothing but the creator surface to import.
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
        const rules = currentRules();
        const player = this.host.owner;
        // Two avatars can reach one leaf on the same tick and both handlers run: the liveness check
        // is what stops the second one scoring a leaf the first already took.
        if (!leaf || !leaf.alive || rules === null || player === null) return;

        const badge = readState<number>(leaf, STATE_BADGE_SLOT);
        const mine = tintSlot(readState<number>(player, STATE_SLOT) ?? 0);
        rules.award(
            player,
            harvestValue({
                ripe: readState<boolean>(leaf, STATE_RIPE) === true,
                badgedForHarvester: badge === mine,
            }),
        );
        leaf.destroy();
    }
}

// Which palette seat a player holds, and where that seat stands them.
//
// Not `player.index`: core allocates indices from a counter a leave never lowers, so after eight
// tabs have come and gone a ninth takes index 8 and would share both a hue and a spawn point with
// whoever still holds index 0.

import type { Player } from '@platform/engine';
import { AVATAR_SCALE, AVATAR_Y, MAX_PLAYERS, avatarX, tintSlot } from '../globals.js';
import { Profile } from '../players/profile.js';

/** The seat this player holds, or seat 0 before `Profile` has been attached. */
export function slotOf(player: Player): number {
    return tintSlot(player.getScript(Profile)?.slot ?? 0);
}

/** The seat of every player currently seated, for the badge draw. */
export function heldSlots(players: readonly Player[]): number[] {
    return players.map(slotOf);
}

/** The lowest seat no live player holds. */
export function freeSlot(players: readonly Player[], joining: Player): number {
    // The joining player is already on the roster carrying `Profile`'s initializer, so counting
    // their own default would push the first player of a session off seat zero.
    const taken = new Set(
        players
            .filter((player) => player.id !== joining.id)
            .map((player) => player.getScript(Profile)?.slot),
    );
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
        if (!taken.has(slot)) return slot;
    }
    return 0;
}

/** Puts a freshly spawned avatar on its seat, at the size its own reach implies. */
export function placeAvatar(player: Player): void {
    if (!player.hasAvatar) return;
    player.avatar.setScale(AVATAR_SCALE);
    player.teleportTo(avatarX(slotOf(player)), AVATAR_Y);
}

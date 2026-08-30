// The `arena-hud` screen — the round overlay and the hotbar.
//
//   Arena  ClientScript<HUDScreen>  the whole screen
//
// Panel-marked open at start, so nothing has to close it.

import {
    ClientScript,
    clamp,
    hud,
    onEvent,
    onPress,
    onUpdate,
    request,
    sound,
} from '@platform/engine';
import type { HUDScreen } from '@platform/engine';

import { RINGS } from './game.js';
import { MAX_HEALTH } from './player.js';
import { fighter, world } from './state.js';
import { SLOTS, WEAPONS } from './weapons.js';
import type { WeaponKey } from './weapons.js';

export class Arena extends ClientScript<HUDScreen> {
    pending: WeaponKey | null = null;
    lastHealth = MAX_HEALTH;

    // Six handlers, because decorator arguments are static — no loop can register
    // them. @onPress names a widget, @onEvent a rebindable action; both land in
    // `select` so they cannot drift.
    @onPress('slot-1') press1() {
        this.select(0);
    }
    @onPress('slot-2') press2() {
        this.select(1);
    }
    @onPress('slot-3') press3() {
        this.select(2);
    }

    @onEvent('equip-1') key1() {
        this.select(0);
    }
    @onEvent('equip-2') key2() {
        this.select(1);
    }
    @onEvent('equip-3') key3() {
        this.select(2);
    }

    select(index: number) {
        const key = SLOTS[index]!;
        const me = fighter(this.localPlayer);
        if (me.equipped === key || me.ammo[key] <= 0) {
            sound.play('deny');
            return;
        }
        this.pending = key;
        request('equip', { weapon: key });
    }

    @onUpdate
    render() {
        const state = world();
        const me = fighter(this.localPlayer);

        // A local read of replicated state is free, so the shake costs nothing.
        if (me.health < this.lastHealth) this.localPlayer.camera.shake(5, 0.2);
        this.lastHealth = me.health;

        hud.bar('health', clamp(me.health / MAX_HEALTH, 0, 1));
        hud.number('clock', state.left);
        hud.number('kills', me.kills);
        hud.text('ring', `Ring ${state.ring} of ${RINGS}`);
        hud.text('standing', `${state.standing} left`);
        hud.text('weapon', WEAPONS[me.equipped].label);

        // The highlight follows `equipped`, never `pending`: displaying authority
        // optimistically is the item-flickers bug.
        if (this.pending !== null && me.equipped === this.pending) this.pending = null;

        for (const [i, key] of SLOTS.entries()) {
            const slot = `slot-${i + 1}`;
            hud.icon(`${slot}-icon`, WEAPONS[key].icon);
            hud.number(`${slot}-ammo`, me.ammo[key]);
            hud.enable(slot, me.ammo[key] > 0 && this.pending === null);
            if (me.equipped === key) hud.show(`${slot}-selected`);
            else hud.hide(`${slot}-selected`);
        }

        if (me.alive) hud.hide('spectating');
        else hud.show('spectating');
    }
}

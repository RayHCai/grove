// The Player template — identity, which outlives the avatar.
//
//   Vitals   ServerScript<Player>   health, kills, ready
//   Loadout  ServerScript<Player>   equipped weapon and ammo
//   Feel     ClientScript<Player>   camera and cursor
//
// The respawn test decides what belongs here; the body is in fighter.ts.

import { ClientScript, ServerScript, onRequest, onStart, serverState } from '@platform/engine';
import type { Ctx, Player } from '@platform/engine';

import { EMPTY, isWeapon } from './weapons.js';
import type { WeaponKey } from './weapons.js';

export const MAX_HEALTH = 5;

// State only — `Match` and the avatar scripts write it, the HUD reads it via state.ts.
export class Vitals extends ServerScript<Player> {
    @serverState health = MAX_HEALTH;
    @serverState alive = true;
    @serverState kills = 0;
    @serverState isReady = false;
}

// Per-player, so it replicates to that player alone — no one else needs my ammo count.
export class Loadout extends ServerScript<Player> {
    @serverState equipped: WeaponKey = 'pea-shooter';
    @serverState ammo: Record<WeaponKey, number> = { ...EMPTY };

    // The hotbar's one crossing of the wire (arena-hud.ts asks). Player-hosted, so the
    // default `ignore` is per-player — the double-press guard a hotbar wants.
    // ctx.data is untrusted, so validate before keying with it.
    @onRequest('equip')
    equip(ctx: Ctx) {
        const key = ctx.data.weapon;
        if (!isWeapon(key) || this.ammo[key] <= 0) return;
        this.equipped = key;
    }
}

// Camera is the one thing client code may write.
export class Feel extends ClientScript<Player> {
    @onStart
    arrive() {
        this.host.camera.follow(this.host.avatar);
        this.host.camera.zoom = 0.9;
        this.host.cursor.setIcon('crosshair');
    }
}

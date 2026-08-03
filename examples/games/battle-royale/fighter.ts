// The `fighter` template — a player's avatar, the body identity drives (§3.2).
//
//   Sprout   SyncedScript<Entity>   the tag, and movement tuning
//   Gunplay  SyncedScript<Entity>   firing, and the crate pickup
//   Hitbox   SyncedScript<Entity>   taking damage
//   Wilt     ServerScript<Entity>   the death sequence
//
// Mostly synced, so the shooter sees their own shot this frame and the server's copy
// decides whether it landed. `Wilt` is the exception and says why. The panel fills
// the movement slot with `TopDownMovement`, so `Sprout` only tunes a number (§4.1).

import {
    ServerScript,
    SyncedScript,
    game,
    onCollide,
    onEvent,
    onStart,
    random,
    sleep,
    sound,
} from '@platform/engine';
import type { Ctx, Entity, Player } from '@platform/engine';

import { fighter, movementOf } from './state.js';
import { SLOTS, WEAPONS } from './weapons.js';
import { Shot } from './shot.js';

// A knob, not a subclass — a subclass is for a new mechanic (§4.1).
export class Sprout extends SyncedScript<Entity> {
    @onStart
    stand() {
        this.host.tag('fighter');
        const movement = movementOf(this.host.owner!);
        if (movement) movement.walkSpeed = 260;
    }
}

export class Gunplay extends SyncedScript<Entity> {
    // `ignore` IS the fire rate: the lock is held across the cooldown await (§5.7).
    @onEvent('shoot', { concurrency: 'ignore' })
    async fire() {
        const me = fighter(this.host.owner!);
        if (!me.alive) return;

        const weapon = WEAPONS[me.equipped];
        if (me.ammo[me.equipped] <= 0) {
            this.host.say('click', 0.4);
            return;
        }
        me.ammo[me.equipped] -= 1;

        // Read by its own owner, so a replay sees the same value.
        const aim = me.cursor.position;
        this.host.faceToward(aim);

        sound.play(weapon.sound, { at: this.host }); // positional
        this.host.playEffect('muzzle');

        for (let i = 0; i < weapon.pellets; i++) {
            const fan = weapon.pellets === 1 ? 0 : (i / (weapon.pellets - 1) - 0.5) * weapon.spread;
            const shot = game.spawn('shot', this.host.position.x, this.host.position.y);
            shot.tag('shot').addScript(Shot);
            shot.send('launch', {
                x: aim.x,
                y: aim.y,
                angle: fan,
                range: weapon.range,
                damage: weapon.damage,
                from: this.host,
            });
        }

        await sleep(weapon.cooldown);
    }

    // One random slot, which is what makes the hotbar a decision.
    @onCollide('crate')
    resupply(ctx: Ctx) {
        const key = random.pick([...SLOTS]);
        fighter(this.host.owner!).ammo[key] += WEAPONS[key].clip;
        sound.play('pickup', { at: this.host });
        ctx.other!.destroy();
    }
}

// One door in for every source of damage: a pellet, the ring, a future trap (§5.8).
export class Hitbox extends SyncedScript<Entity> {
    @onEvent('hit')
    hurt(ctx: Ctx) {
        const me = fighter(this.host.owner!);
        if (!me.alive) return;

        me.health -= ctx.data.amount as number;
        this.host.playEffect('leaf-burst');
        if (me.health <= 0) this.host.send('down', { by: ctx.data.by });
    }
}

// Server-only: crediting a kill is not a client's call. A client re-producing the
// synced `hit` reaches Hitbox and skips this — handlers run where their class says
// (§5.8).
export class Wilt extends ServerScript<Entity> {
    @onEvent('down')
    async fall(ctx: Ctx) {
        const me = fighter(this.host.owner!);
        if (!me.alive) return; // two pellets can land on one tick
        me.alive = false;
        me.health = 0;

        const killer = ctx.data.by as Player | null;
        if (killer && killer !== me) fighter(killer).kills += 1;

        const movement = movementOf(me);
        if (movement) {
            movement.stop();
            movement.enabled = false;
        }

        sound.play('wilt', { at: this.host });
        this.host.playEffect('leaf-burst');
        this.host.play('wilt');

        this.host.spin(90, 0.8); // unawaited: a droop alongside the fade, not after
        await this.host.fadeOut(0.8);

        if (me.avatar === this.host) me.spectate();
    }
}

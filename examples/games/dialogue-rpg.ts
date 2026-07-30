// Lantern Gem — a very small dialogue RPG.
// Talk to the elder, find the gem in the woods, bring it back, get paid.
//
// Panel-authored: the `village` level, the `elder` / `gem` / `signpost` prefabs,
// the `woods` region, the `hint` HUD label. The level is scenery only — the cast
// is spawned in `LanternGem.build()` at the bottom.
//
// Illustrative only — written against api_spec.ts, not compiled or run.

import {
    BaseGame,
    BaseMovement,
    BasePlayer,
    Inventory,
    Script,
    clamp,
    music,
    onClick,
    onCollide,
    onStart,
    sound,
    state,
    hud,
} from '@platform/engine';
import type { Ctx, Vec3 } from '@platform/engine';

// ─── movement ──────────────────────────────────────────────────────────

// One press = one tile, input ignored until it lands. A subclass, not a knob:
// committing to a destination needs state across ticks, which no tuning of
// TopDownMovement can give.

class GridStepMovement extends BaseMovement {
    tileSize = 64;
    stepSeconds = 0.18;
    override maxSpeed = 400; // must clear stepSpeed or steps stall

    // Per-entity and replicated, so the panel's animation config can pick
    // `walk-left` vs `idle-left` with no code here.
    @state stepping = false;
    @state facing = 'down'; // down | up | left | right

    // The step in flight. Plain fields: both machines derive them from the same
    // inputs, so there is nothing to replicate.
    private dirX = 0;
    private dirY = 0;
    private remaining = 0;

    get stepSpeed() {
        return this.tileSize / this.stepSeconds;
    }

    protected override accelerate(intent: Vec3, dt: number) {
        if (this.stepping) {
            this.drive(dt); // destination already decided; intent ignored
            return;
        }

        if (intent.x === 0 && intent.y === 0) {
            this.stop();
            return;
        }

        // Dominant axis wins, so a diagonal press covers one tile, not 1.41.
        const horizontal = Math.abs(intent.x) > Math.abs(intent.y);
        this.beginStep(horizontal ? Math.sign(intent.x) : 0, horizontal ? 0 : Math.sign(intent.y));
    }

    // Its own verb, so a two-tile dash or an ice tile that chains another step
    // can override what starts a step without touching how one is driven.
    protected beginStep(dx: number, dy: number) {
        this.dirX = dx;
        this.dirY = dy;
        this.facing = dx !== 0 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'up' : 'down';
        this.remaining = this.tileSize;
        this.stepping = true;
    }

    // Velocity is the only write channel, so landing on the tile line means
    // asking for less velocity on the last tick, not writing position.
    private drive(dt: number) {
        const distance = clamp(this.stepSpeed * dt, 0, this.remaining);
        this.remaining -= distance;

        this.velocity.x = (this.dirX * distance) / dt;
        this.velocity.y = (this.dirY * distance) / dt;

        if (this.remaining <= 0) this.stepping = false;
    }

    // End the step early instead of shoving at a wall for the full stepSeconds.
    // `blocked` is last tick's resolution — there is no collision hook.
    protected override applyForces(dt: number) {
        super.applyForces(dt);

        if (!this.stepping) return;
        const wall =
            (this.dirX < 0 && this.blocked.left) ||
            (this.dirX > 0 && this.blocked.right) ||
            (this.dirY > 0 && this.blocked.up) ||
            (this.dirY < 0 && this.blocked.down);

        if (wall) {
            this.stepping = false;
            this.remaining = 0;
            this.stop();
        }
    }
}

// ─── player ────────────────────────────────────────────────────────────

// Quest progress and coins survive respawn, so they are identity, not body.

class Player extends BasePlayer {
    @state stage = 'greet'; // greet -> searching -> carrying -> done
    @state coins = 0;

    readonly bag = new Inventory(this);

    @onStart // this player joined
    arrive() {
        // Panel attachment is the usual path; a game with its own movement class
        // can attach it here. Concrete subclass only — the base is abstract.
        this.avatar.setMovement(GridStepMovement);

        hud.text('hint', 'Find the elder in the square.', { for: this });
        hud.number('purse', this.coins, { for: this });
    }
}

// ─── the elder ─────────────────────────────────────────────────────────

// One branch per quest stage. No dialogue graph, no node ids — the whole
// conversation is `say` plus a string on Player.

class Elder extends Script {
    @onClick
    async talk(ctx: Ctx) {
        const player = ctx.player!;

        if (this.entity.distanceTo(player.avatar) > 128) {
            await this.entity.say('Come closer, traveller.', 2, { for: player }); // two tiles off
            return;
        }

        this.entity.faceToward(player.avatar);

        if (player.stage === 'greet') {
            await this.entity.say('My lantern gem fell somewhere in the woods.', 3, {
                for: player,
            });
            await this.entity.say('Bring it back and I will make it worth your while.', 3, {
                for: player,
            });
            player.stage = 'searching';
            hud.text('hint', 'Search the woods for the lantern gem.', { for: player });
            return;
        }

        if (player.stage === 'searching') {
            await this.entity.say('Still lost? Try past the tall pines.', 2, { for: player });
            return;
        }

        if (player.stage === 'carrying') {
            await this.entity.say('You found it! The square will be bright tonight.', 3, {
                for: player,
            });
            player.bag.remove('gem');
            player.coins += 10;
            player.stage = 'done';

            this.game.gemsReturned += 1;
            sound.play('coin-purse', { at: this.entity });
            hud.number('purse', player.coins, { for: player });
            hud.text('hint', 'Thanks, traveller.', { for: player });
            this.entity.play('lantern-lit');
            return;
        }

        await this.entity.say('Safe travels.', 2, { for: player });
    }
}

// ─── the gem ───────────────────────────────────────────────────────────

class Gem extends Script {
    @onStart
    hover() {
        this.entity.playEffect('sparkle', { loop: true });
    }

    @onCollide('player')
    pickUp(ctx: Ctx) {
        const player = ctx.player!;
        if (player.stage !== 'searching') return; // not their quest yet

        player.bag.add('gem');
        player.stage = 'carrying';

        player.avatar.say('A lantern gem!', 2);
        sound.play('chime', { for: player });
        hud.text('hint', 'Take the gem back to the elder.', { for: player });

        this.entity.destroy();
    }
}

// ─── scenery that talks ────────────────────────────────────────────────

class Signpost extends Script {
    @onClick
    async read(ctx: Ctx) {
        await this.entity.think('← square    woods →', 2, { for: ctx.player! });
    }
}

// ─── game ──────────────────────────────────────────────────────────────

// @onStart is world-building and must not assume a player exists yet.

class LanternGem extends BaseGame {
    @state gemsReturned = 0;

    @onStart
    async build() {
        await this.scene.load('village'); // ground, trees, houses — no cast

        // `spawn` is eager and returns a live entity, so setters chain off it.
        this.scene.spawn('elder', 0, 40).tag('villager').addScript(Elder).say('Ah — a traveller.');

        this.scene.spawn('signpost', -220, 0).addScript(Signpost);
        this.scene.spawn('signpost', 220, 0).addScript(Signpost);

        // Seeded, so a shared link drops the gem in the same place for everyone.
        this.random.seed(1809);
        const spot = this.random.pointIn('woods');
        this.scene.spawn('gem', spot.x, spot.y).tag('quest').addScript(Gem);

        music.play('village-dusk', { loop: true, fade: 2 });
    }
}

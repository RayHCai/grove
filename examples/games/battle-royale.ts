// Last Sprout — a very small top-down battle royale.
// Drop into the arena, grab a pea-shooter, survive four closing circles.
//
// Panel-authored: the `arena` level, the `ring-1..4` regions, the `ring-marker` /
// `player-shot` / `pickup` prefabs, the `ammo` / `health` / `zone` / `dash-icon`
// HUD widgets. `TopDownMovement` — the prebuilt perspective class, not a "top-down
// template" — is attached to the avatar prefab, so this file only tunes one number.
//
// Illustrative only — written against api_spec.ts, not compiled or run.

import {
    BaseGame,
    BasePlayer,
    Countdown,
    Leaderboard,
    Script,
    after,
    every,
    hud,
    music,
    onCollide,
    onEvent,
    onExit,
    onPlayerJoin,
    onStart,
    onUpdate,
    sleep,
    sound,
    state,
} from '@platform/engine';
import type { Ctx, TopDownMovement } from '@platform/engine';

// ─── player ────────────────────────────────────────────────────────────

// `down` must survive the avatar being destroyed, so it is identity, not body.

class Player extends BasePlayer {
    @state health = 3;
    @state down = false;
    @state kills = 0;

    @onStart
    arrive() {
        const movement = this.avatar.movement as TopDownMovement;
        movement.walkSpeed = 260; // the whole movement setup

        // Usually panel-attached; here so the loadout reads in one place.
        this.avatar.addScript(PeaShooter).addScript(Dash);

        this.camera.follow(this.avatar);
        this.camera.zoom = 0.9;
        this.cursor.setIcon('crosshair');
    }
}

// ─── the dash ──────────────────────────────────────────────────────────

// A script, not a movement subclass: a cooldown and one `impulse` are no business
// of the movement type's.

class Dash extends Script {
    @state ready = true; // replicated, so the HUD can grey the icon out

    @onEvent('dash')
    async go() {
        if (!this.ready) return;

        const movement = this.entity.movement!;
        const dir = movement.intent; // where the player is already heading
        if (dir.x === 0 && dir.y === 0) return; // standing still, no dash

        // Discrete Δvelocity, never dt-scaled — same ground covered at any simRate.
        movement.impulse(dir.x * 520, dir.y * 520);
        sound.play('whoosh', { at: this.entity });
        this.entity.playEffect('dust');

        this.ready = false;
        hud.disable('dash-icon', { for: this.player! });
        await sleep(1.5);
        this.ready = true;
        hud.enable('dash-icon', { for: this.player! });
    }
}

// ─── the gun ───────────────────────────────────────────────────────────

class PeaShooter extends Script {
    @state loaded = 6;

    // 'ignore' *is* the fire rate: the handler holds its lock across the cooldown,
    // so a held button cannot re-enter it.
    @onEvent('shoot', { concurrency: 'ignore' })
    async fire() {
        if (this.loaded === 0) {
            this.entity.say('click', 0.5);
            return;
        }
        this.loaded -= 1;

        const aim = this.player!.cursor.position; // per-player; safe to read for its owner
        this.entity.faceToward(aim);

        const shot = this.scene.spawn(
            'player-shot',
            this.entity.position.x,
            this.entity.position.y,
        );
        shot.tag('shot').faceToward(aim).addScript(Shot);
        shot.send('launch', { x: aim.x, y: aim.y });

        sound.play('pop', { at: this.entity });
        hud.number('ammo', this.loaded, { for: this.player! });
        await sleep(0.25);
    }

    @onCollide('pickup')
    reload(ctx: Ctx) {
        this.loaded = 6;
        ctx.other!.destroy();
        hud.number('ammo', this.loaded, { for: this.player! });
    }
}

class Shot extends Script {
    // The aim point arrives as a payload; the pea glides there and cleans itself up.
    @onEvent('launch')
    async travel(ctx: Ctx) {
        await this.entity.glideTo(ctx.data.x as number, ctx.data.y as number, 0.4);
        if (this.entity.alive) this.entity.destroy();
    }

    @onCollide('player')
    hit(ctx: Ctx) {
        const victim = ctx.other!.owner as Player | null;
        this.entity.destroy();
        if (!victim || victim.down) return;

        victim.health -= 1;
        victim.camera.shake(5, 0.2);
        hud.bar('health', victim.health / 3, { for: victim });

        if (victim.health <= 0) this.game.knockOut(victim);
    }
}

// ─── the closing ring ──────────────────────────────────────────────────

// The edge ("just left") warns; the level ("still outside") damages, in `burn`
// below. Two questions, two mechanisms.

class Ring extends Script {
    @onExit('ring-1')
    stepOut(ctx: Ctx) {
        const player = ctx.player!;
        player.avatar.say('Get back in the circle!', 2, { for: player });
    }
}

// ─── game ──────────────────────────────────────────────────────────────

class LastSprout extends BaseGame {
    @state playing = false;
    @state ring = 1; // 1..4, smallest last

    readonly wins = new Leaderboard({ order: 'high', persist: true });
    readonly clock = new Countdown(120);

    @onStart
    async build() {
        await this.scene.load('arena');

        // One marker carries the region handlers; the circles are panel-drawn regions.
        this.scene.spawn('ring-marker').addScript(Ring);

        every(4, () => {
            const spot = this.random.pointIn(`ring-${this.ring}`);
            this.scene.spawn('pickup', spot.x, spot.y).tag('pickup');
        });
    }

    // Roster changes are a Game concern; per-player setup lives on Player.
    @onPlayerJoin
    join(ctx: Ctx) {
        if (this.playing) ctx.player!.spectate();
        else ctx.player!.spawn();
        if (this.players.length >= 2) this.begin();
    }

    begin() {
        if (this.playing) return; // own guard — there is no engine endRound
        this.playing = true;
        this.ring = 1;

        for (const player of this.players) {
            player.health = 3;
            player.down = false;
            player.spawn();
        }

        this.clock.reset(120);
        this.clock.start();
        hud.timer('zone', this.clock);
        music.play('drums', { loop: true });

        // Code only says which circle is live.
        after(30, () => this.shrink());
        after(60, () => this.shrink());
        after(90, () => this.shrink());
        after(110, () => this.shrink());
    }

    shrink() {
        if (!this.playing) return;
        this.ring += 1;
        for (const player of this.players) {
            player.camera.shake(3, 0.4);
            hud.text('zone-label', `Circle ${this.ring}`, { for: player });
        }
        sound.play('siren');
    }

    // A level read, so `isTouching` rather than @onEnter/@onExit bookkeeping.
    @onUpdate
    burn() {
        if (!this.playing) return;
        for (const player of this.players) {
            if (player.down) continue;
            if (player.avatar.isTouching(`ring-${this.ring}`)) continue;

            player.avatar.playEffect('scorch');
            if (this.random.chance(0.02)) {
                player.health -= 1;
                if (player.health <= 0) this.knockOut(player);
            }
        }
    }

    knockOut(player: Player) {
        if (player.down) return; // two shots can land on the same tick
        player.down = true;
        player.avatar.play('wilt');
        player.spectate();

        const standing = this.players.filter((p) => !p.down);
        if (standing.length === 1) this.declare(standing[0]!);
    }

    declare(winner: Player) {
        this.playing = false;
        this.clock.pause();
        this.wins.submit(1, winner);

        winner.avatar.say('Last sprout standing!');
        music.stop(1);
        sound.play('fanfare');

        for (const player of this.players) {
            hud.text('result', player === winner ? 'You win!' : `${winner.name} wins`, {
                for: player,
            });
        }

        after(8, () => this.begin());
    }
}

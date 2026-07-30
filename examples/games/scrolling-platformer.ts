// Coin Run — a very small endless-ish scrolling platformer.
// Run right, jump the gaps, grab coins, don't touch the spikes.
//
// Panel-authored: the `chunk-*` / `coin` / `spike` / `springboard` prefabs and
// the `score` HUD number. `SideViewMovement` — the prebuilt perspective class,
// not a "platformer template" — is attached to the avatar prefab, so gravity and
// jumping come for free and this file only tunes two numbers.
//
// Illustrative only — written against api_spec.ts, not compiled or run.

import {
    BaseGame,
    BasePlayer,
    Script,
    Scoreboard,
    hud,
    onCollide,
    onStart,
    onUpdate,
    sound,
    state,
} from '@platform/engine';
import type { Ctx, SideViewMovement } from '@platform/engine';

// ─── player ────────────────────────────────────────────────────────────

// No movement class here — two knobs make this a runner instead of a walker.

class Player extends BasePlayer {
    @state best = 0; // furthest x this run

    @onStart
    arrive() {
        this.spawn();

        // The knobs belong to the attached subclass; only `maxSpeed` is on the base.
        const movement = this.avatar.movement as SideViewMovement;
        movement.walkSpeed = 300; // a sprint, not a stroll
        movement.jumpStrength = 560; // clears a two-tile gap

        this.camera.follow(this.avatar);
        this.camera.zoom = 1.2;
    }
}

// ─── pickups and hazards ───────────────────────────────────────────────

// Attached in the panel, never spawned here: `scene.stream` spawns a chunk and
// the chunk arrives already carrying its coins, spikes and springboards.

class Coin extends Script {
    @onCollide('player')
    collect(ctx: Ctx) {
        this.game.scores.add(1, ctx.player!);
        hud.number('score', this.game.scores.of(ctx.player!), { for: ctx.player! });
        sound.play('coin', { at: this.entity });
        this.entity.destroy();
    }
}

class Spike extends Script {
    @onCollide('player', { concurrency: 'ignore' })
    async sting(ctx: Ctx) {
        const player = ctx.player!;
        player.camera.shake(6, 0.3);
        sound.play('thud', { for: player });
        await player.avatar.fadeOut(0.2);
        player.respawn(); // back to the last checkpoint
        await player.avatar.fadeIn(0.2);
    }
}

class Springboard extends Script {
    @onCollide('player')
    launch(ctx: Ctx) {
        // Discrete Δvelocity, never dt-scaled — the bounce is identical at any simRate.
        ctx.other!.movement!.impulse(0, 900);
        this.entity.play('boing');
    }
}

// ─── game ──────────────────────────────────────────────────────────────

class CoinRun extends BaseGame {
    @state chunksMade = 0;

    readonly scores = new Scoreboard();

    @onStart
    async build() {
        await this.scene.create(); // empty world; the chunks below fill it

        // The engine owns the frontier and reclaim; we only name the next chunk.
        this.scene.stream({
            ahead: 3,
            behind: 1,
            next: () => {
                this.chunksMade += 1;
                // Gaps only start appearing after a few easy chunks.
                return this.chunksMade < 3
                    ? 'chunk-flat'
                    : this.random.pick(['chunk-flat', 'chunk-gap', 'chunk-stairs', 'chunk-spikes']);
            },
        });
    }

    @onUpdate
    trackProgress() {
        for (const player of this.players) {
            const x = player.avatar.position.x;
            if (x > player.best) player.best = x;

            if (player.avatar.position.y < this.scene.bounds.bottom) player.respawn(); // fell out
        }
    }
}

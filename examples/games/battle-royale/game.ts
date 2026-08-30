// The Game template — the session and the world.
//
//   Match    ServerScript<Game>   phases, clock, ring, roster, leaderboard
//   Screens  ClientScript<Game>   which screen is up, and the music
//
// Two locations on one host: the orchestrator is authoritative, "which menu is up" is
// one player's screen. The round's shape is declared here because Match enforces it;
// the HUD imports it to label what it draws.

import {
    ClientScript,
    Countdown,
    Leaderboard,
    ServerScript,
    every,
    game,
    hud,
    music,
    onPlayerJoin,
    onRequest,
    onStart,
    onUpdate,
    random,
    serverState,
    sleep,
    sound,
} from '@platform/engine';
import type { Ctx, Game, Player } from '@platform/engine';

import { MAX_HEALTH } from './player.js';
import { fighter, movementOf, world } from './state.js';
import type { Phase } from './state.js';
import { EMPTY, WEAPONS } from './weapons.js';

export const ROUND = 120; // seconds
export const RINGS = 3; // ring-1 is the whole arena, ring-3 the last patch
export const TO_START = 2; // players needed to begin

// Server, not synced: a Game-hosted synced script re-produces on every client.
export class Match extends ServerScript<Game> {
    @serverState phase: Phase = 'lobby';
    @serverState left = ROUND;
    @serverState ring = 1;
    @serverState standing = 0;
    @serverState winner = ''; // '' while a round is live
    @serverState board: Array<{ name: string; wins: number }> = [];

    readonly wins = new Leaderboard({ order: 'high', persist: true });
    readonly clock = new Countdown(ROUND);

    // Must not assume a player exists: the roster arrives after the world.
    @onStart
    build() {
        this.publish();

        every(6, () => {
            if (this.phase !== 'arena') return;
            const spot = random.pointIn(`ring-${this.ring}`);
            game.spawn('crate', spot.x, spot.y).tag('crate');
        });

        every(0.25, () => this.step());
        every(1, () => this.burn());
    }

    // Mid-round arrivals watch this one out.
    @onPlayerJoin
    join(ctx: Ctx) {
        if (this.phase === 'arena') ctx.player!.spectate();
        else ctx.player!.spawn();
        this.publish();
    }

    // `concurrent` because a Game-hosted handler has one instance, so the default
    // `ignore` would serialize every player's ready-up.
    @onRequest('ready', { concurrency: 'concurrent' })
    ready(ctx: Ctx) {
        if (this.phase === 'arena') return;
        fighter(ctx.player!).isReady = true;

        const ready = game.players.filter((p) => fighter(p).isReady).length;
        if (ready >= TO_START && ready === game.players.length) this.begin();
    }

    begin() {
        if (this.phase === 'arena') return; // own guard; there is no engine endRound
        this.phase = 'arena';
        this.ring = 1;
        this.winner = '';
        this.left = ROUND;

        for (const p of game.players) {
            const f = fighter(p);
            f.health = MAX_HEALTH;
            f.alive = true;
            f.kills = 0;
            f.isReady = false;
            f.equipped = 'pea-shooter';
            f.ammo = { ...EMPTY, 'pea-shooter': WEAPONS['pea-shooter'].clip };
            f.spawn();
            this.freeze(p, false);
        }

        this.standing = game.players.length;
        this.clock.reset(ROUND);
        this.clock.start();
    }

    step() {
        if (this.phase !== 'arena') return;
        this.left = Math.max(0, Math.ceil(this.clock.remaining));

        // Derived from the clock, not scheduled with `after`, so an early finish
        // leaves no stale timers to fire into the next round.
        const ring = 1 + Math.min(RINGS - 1, Math.floor((ROUND - this.left) / (ROUND / RINGS)));
        if (ring !== this.ring) {
            this.ring = ring;
            sound.play('siren');
            for (const p of game.players) p.camera.shake(3, 0.4);
        }

        const alive = game.players.filter((p) => fighter(p).alive);
        this.standing = alive.length;

        if (alive.length === 1) this.declare(alive[0]!);
        else if (this.left === 0) {
            // Most kills takes it; nobody standing takes nobody.
            const best = alive.toSorted((a, b) => fighter(b).kills - fighter(a).kills)[0];
            if (best) this.declare(best);
            else this.finish('');
        }
    }

    // A level read, so a query rather than @onEnter/@onExit bookkeeping. Same `hit`
    // door a pellet uses (fighter.ts); `by` is null, so the ring credits nobody.
    burn() {
        if (this.phase !== 'arena') return;
        const safe = game.find({ in: `ring-${this.ring}`, tag: 'fighter' });

        for (const p of game.players) {
            if (!fighter(p).alive || safe.includes(p.avatar)) continue;
            p.avatar.playEffect('scorch');
            p.avatar.send('hit', { amount: 1, by: null });
        }
    }

    declare(player: Player) {
        this.wins.submit(1, player);
        player.avatar.say('Last sprout standing!');
        this.finish(player.name);
    }

    async finish(name: string) {
        this.phase = 'over';
        this.winner = name;
        this.clock.pause();
        sound.play('fanfare');
        for (const p of game.players) this.freeze(p, true);

        this.publish();
        await sleep(8);

        this.phase = 'lobby';
        for (const p of game.players) {
            fighter(p).isReady = false;
            fighter(p).alive = true;
            p.spawn(); // back to the greenhouse
            this.freeze(p, false);
        }
    }

    // stop() then enabled, or friction keeps everyone coasting.
    freeze(player: Player, frozen: boolean) {
        const movement = movementOf(player);
        if (!movement) return;
        if (frozen) movement.stop();
        movement.enabled = !frozen;
    }

    publish() {
        this.board = this.wins.top(5).map((r) => ({ name: r.player.name, wins: r.score }));
    }
}

// Session-scoped client state. Follows the replicated phase; never sets it.
export class Screens extends ClientScript<Game> {
    shown = ''; // no phase equals this, so the first frame always opens

    @onUpdate
    follow() {
        const phase = world().phase;
        if (phase === this.shown) return;
        this.shown = phase;

        hud.close(phase === 'arena' ? 'lobby' : 'arena-hud');
        hud.open(phase === 'arena' ? 'arena-hud' : 'lobby');
        music.play(phase === 'arena' ? 'drums' : 'greenhouse', { loop: true, fade: 1 });
    }
}

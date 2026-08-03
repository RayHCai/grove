// Seed Sprint — a single-player endless scrolling platformer. Run right, jump the
// gaps, don't fall. The corridor generates ahead of you and is reclaimed behind.
//
// ONE FILE PER HOST, holding every script the panel attaches there (§3.4, §8):
//
//   game.ts    the Game    Terrain (server), Sky (client)   ← you are here
//   sprout.ts  `sprout`    SproutMovement, Sprout, View
//
// No HUD, no screens, no score — the run is the whole game, and dying restarts it.
//
// Panel-authored: the `chunk-*` templates (script-free, so baked static §8.2), the
// `backdrop`-tagged parallax sprites, the `dust` effect, and the `jump` / `moveX`
// actions. Attachment is panel mapping (§3.2), so nothing imports these.
//
// Illustrative only — written against api_spec.ts, not compiled or run.
//
// ─── this file ─────────────────────────────────────────────────────────
//
//   Terrain  ServerScript<Game>   streams the corridor, restarts a dead run
//   Sky      ClientScript<Game>   parallax and music
//
// Single player (`maxPlayers: 1`), but the loops still read `game.players`: a
// Game-hosted @onStart must not assume a player exists (§3.6).

import {
    ClientScript,
    ServerScript,
    every,
    game,
    music,
    onPlayerJoin,
    onStart,
    onUpdate,
    random,
    serverState,
    sound,
} from '@platform/engine';
import type { Ctx, Game } from '@platform/engine';

const CHUNK_WIDTH = 800;
const AHEAD = 2400; // spawn this far past the runner
const BEHIND = 1600; // reclaim this far back
const START = ['chunk-flat', 'chunk-flat', 'chunk-gap']; // the first few, kept easy

// Streaming is a script, not an engine feature — `scene.stream` is gone with Scene
// (§8.4). Server, not synced: a Game-hosted synced script re-produces on every
// client (§1.2), and spawning is authoritative anyway.
export class Terrain extends ServerScript<Game> {
    @serverState frontier = 0; // world x the corridor is built to
    @serverState made = 0; // chunks this run — the difficulty ramp

    chunks = ['chunk-flat', 'chunk-gap', 'chunk-stairs', 'chunk-tower'];

    @onStart
    build() {
        this.extend(0); // a floor exists before anyone lands on it

        // On a timer, not @onUpdate: a chunk is 800px wide, so 5 Hz is many seconds
        // of slack at any running speed, and this is the polling §5.1 warns about.
        every(0.2, () => {
            const lead = this.lead();
            this.extend(lead);
            this.reclaim(lead);
        });

        // Death is a fall out of the world — there is no floor down there to collide
        // with, so it is a level read rather than a handler (§5.4).
        every(0.1, () => {
            for (const p of game.players) {
                if (p.avatar.position.y < game.bounds.bottom) this.restart();
            }
        });
    }

    @onPlayerJoin
    join(ctx: Ctx) {
        ctx.player!.spawn();
    }

    // What "the frontier" means with several players is the creator's call; with one
    // it is just their x (§8.4).
    lead() {
        let x = 0;
        for (const p of game.players) x = Math.max(x, p.avatar.position.x);
        return x;
    }

    extend(lead: number) {
        while (this.frontier < lead + AHEAD) {
            // Easy chunks first, then anything — a ramp the engine's `next` callback
            // could not have expressed.
            const key = this.made < START.length ? START[this.made]! : random.pick(this.chunks);
            game.spawn(key, this.frontier, 0).tag('chunk');
            this.frontier += CHUNK_WIDTH;
            this.made += 1;
        }
    }

    reclaim(lead: number) {
        for (const c of game.find({ tag: 'chunk' })) {
            if (c.position.x < lead - BEHIND) c.destroy();
        }
    }

    // No lives and no result screen: the run just starts over. Rebuilding from zero
    // is what makes the first chunks easy again.
    restart() {
        sound.play('wither');

        for (const c of game.find({ tag: 'chunk' })) c.destroy();
        this.frontier = 0;
        this.made = 0;
        this.extend(0);

        for (const p of game.players) {
            if (p.movement) p.movement.stop(); // no inherited speed into the new run
            p.teleportTo(0, 0); // hard cut; resets client prediction (§3.2)
        }
    }
}

// Presentation only, so client-side: a parallax offset is a fact about one screen,
// and `viewport` is not readable from synced code at all (§3.3).
export class Sky extends ClientScript<Game> {
    // Music only: a Game host's @onStart is session start, which is before this
    // player's avatar exists (§3.6). The camera is set up in sprout.ts, where the
    // body's own @onStart guarantees there is something to follow.
    @onStart
    begin() {
        music.play('sprint', { loop: true, fade: 1 });
    }

    // Display rate, not simRate (§12.2) — this is a render pass.
    @onUpdate
    drift() {
        const view = this.localPlayer.camera.viewport;
        const mid = (view.left + view.right) / 2;

        // Layer 0 is furthest, so it moves least. `layer` is draw order, not depth
        // (§2), which is why the parallax factor is read off it rather than z.
        for (const b of game.find({ tag: 'backdrop' })) {
            b.setPosition(mid * (1 - b.layer * 0.25), b.position.y);
        }
    }
}

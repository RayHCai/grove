// What the world is worth so far: the score, and the two routes it arrived by.
//
// Game-hosted like `Rules`, and separate from it so that the scripts which SCORE — the collector on
// every avatar, the orb that was clicked — can reach a ledger without reaching the rules that spawn
// them. One import each way is a cycle; this is the shared end of it.

import type { Game, Player } from '@platform/engine';
import { Scoreboard, ServerScript, serverState } from '@platform/engine';
import { Profile } from './profile.js';

export class Ledger extends ServerScript<Game> {
    /** Game-hosted, so every peer sees these — a player-hosted field reaches only its owner. */
    @serverState collected = 0;
    /** The same total split by route: walked into, and clicked from wherever the clicker stood. */
    @serverState walked = 0;
    @serverState popped = 0;
    /** The region pass's two edges, counted. */
    @serverState ripened = 0;
    @serverState cooled = 0;

    /** Never `@serverState`: a wrapper marks its own channel from inside its mutating methods. */
    scores = new Scoreboard();

    award(player: Player, points: number): void {
        this.walked = this.walked + points;
        this.#score(player, points);
    }

    steal(player: Player, points: number): void {
        this.popped = this.popped + points;
        this.#score(player, points);
    }

    noteRipe(): void {
        this.ripened = this.ripened + 1;
    }

    noteCool(): void {
        this.cooled = this.cooled + 1;
    }

    /** Every other script scores through here, so the wrapper has one writer. */
    #score(player: Player, points: number): void {
        // Passed explicitly: the acting-player ambient is only available inside a handler driven by
        // one, and `Scoreboard.add` throws rather than silently losing a score.
        this.scores.add(points, player);
        this.collected = this.collected + points;
        const profile = player.getScript(Profile);
        if (profile === null) return;
        profile.taken += points;
        profile.lifetime += points;
        profile.best = Math.max(profile.best, profile.taken);
    }
}

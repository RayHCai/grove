// The Game's own script: the roster, the match clock, the drift pass and the scores.
//
// Every `@serverState` field is REASSIGNED wherever it changes — only the setter marks the
// replication channel, so a value mutated in place would replicate nothing.

import type { Ctx, Game, Player } from '@platform/engine';
import {
    Countdown,
    Leaderboard,
    Scoreboard,
    ServerScript,
    every,
    onEnd,
    onPlayerJoin,
    onPlayerLeave,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/engine';
import type { MatchPhase } from '../globals.js';
import {
    AVATAR_Y,
    CROWN_TEMPLATE,
    LEAF_INTERVAL,
    MARKER_LAYER,
    RESULTS_SECONDS,
    ROUND_SECONDS,
    WIDGET_READY,
    avatarX,
} from '../globals.js';
import { declareCrown } from '../session.js';
import { Clicker } from '../players/clicker.js';
import { Profile } from '../players/profile.js';
import { dropBand, hasExited, liveLeaves, spawnLeaf, stepLeaf } from '../templates/leaf/leaf.js';
import { freeSlot, heldSlots, placeAvatar, slotOf } from './slots.js';

/** The tag the reopen sweeps last round's crown by. */
const CROWN_TAG = 'crown';

export class Rules extends ServerScript<Game> {
    /** Inspector values, written by the engine between construction and the `@serverState` hoist. */
    roundSeconds = ROUND_SECONDS;
    resultsSeconds = RESULTS_SECONDS;
    leafInterval = LEAF_INTERVAL;

    /** Game-hosted, so every peer sees these — a player-hosted field reaches only its owner. */
    @serverState phase: MatchPhase = 'lobby';
    /** Seconds left in the round, or in the results dwell — one clock, whichever is running. */
    @serverState secondsLeft = 0;
    @serverState readyCount = 0;
    @serverState playerCount = 0;
    @serverState winnerName = '';
    @serverState wasted = 0;
    @serverState round = 0;

    /** Never `@serverState`: a wrapper marks its own channel from inside its mutating methods. */
    scores = new Scoreboard();
    board = new Leaderboard({ order: 'high' });

    /** Rebuilt per round, because a spent one has already fired and deregistered. */
    #clock: Countdown | null = null;
    /** Cancels the leaf drop; null outside a round. */
    #dropping: (() => void) | null = null;
    /** Announced once per world, the first time a round is won. */
    #crowned = false;

    @onStart
    begin(): void {
        // One write a second rather than one a tick: the value is a whole second, and marking the
        // channel sixty times to send the same integer is the shape of a wire nobody profiled.
        every(1, () => this.#second());
    }

    @onEnd
    end(): void {
        this.#stopRound();
    }

    /** `spawn()` owns the avatar to this player, which is what puts it in that client's predicted scope. */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Clicker);
        player.addScript(Profile);
        const profile = player.getScript(Profile);
        if (profile !== null) {
            // The hoist seeded these from this player's saved record, so the per-session flag is
            // cleared rather than resumed.
            profile.ready = false;
            profile.slot = freeSlot(this.host.players, player);
        }
        player.spawn();
        placeAvatar(player);
        this.#recount();
    }

    /** The roster still holds the leaver here, which is why the recount is told who to leave out. */
    @onPlayerLeave
    leave(ctx: Ctx): void {
        this.#recount(ctx.player?.id);
        // A round with nobody left in it ends rather than dropping leaves into an empty world.
        if (this.playerCount === 0 && this.phase === 'playing') this.#endRound();
        // The tab that had not readied may be the one that just left, which would otherwise leave
        // the lobby reading "2/2 ready" with nothing starting until somebody pressed twice.
        else this.#startIfEveryoneReady();
    }

    /** A press rides the interaction frame, so `ctx.player` is engine-supplied rather than claimed. */
    @onPress(WIDGET_READY)
    ready(ctx: Ctx): void {
        const player = ctx.player;
        if (!player || this.phase !== 'lobby') return;
        const profile = player.getScript(Profile);
        if (profile === null) return;
        profile.ready = !profile.ready;
        this.#recount();
        this.#startIfEveryoneReady();
    }

    @onUpdate
    drift(ctx: Ctx): void {
        const game = this.host;
        const bounds = game.bounds;

        for (const leaf of liveLeaves(game)) {
            const next = stepLeaf(leaf.position.x, leaf.rotation, ctx.dt);
            // The backstop, not the reap: `Leaf` composts it on the region edge well before here.
            if (hasExited(next.x, bounds)) {
                leaf.destroy();
                continue;
            }
            leaf.setPosition(next.x, leaf.position.y);
            leaf.setRotation(next.rotation);
        }
    }

    /** @internal — every other script scores through here, so the wrapper has one writer. */
    award(player: Player, points: number): void {
        if (this.phase !== 'playing') return;
        // Passed explicitly: the acting-player ambient is only available inside a handler driven by
        // one, and `Scoreboard.add` throws rather than silently losing a score.
        this.scores.add(points, player);
    }

    /** @internal — a leaf nobody caught. */
    noteWasted(): void {
        if (this.phase !== 'playing') return;
        this.wasted = this.wasted + 1;
    }

    /**
     * Everyone connected, and at least one of them.
     *
     * A solo tab can still start a round, which is what makes this runnable without a second browser
     * open — and a joiner who has not readied holds the round up.
     */
    #startIfEveryoneReady(): void {
        if (this.phase !== 'lobby') return;
        if (this.readyCount > 0 && this.readyCount === this.playerCount) this.#startRound();
    }

    #startRound(): void {
        const game = this.host;
        for (const leaf of liveLeaves(game)) leaf.destroy();
        this.scores.reset();
        this.wasted = 0;
        this.round = this.round + 1;
        this.winnerName = '';
        this.phase = 'playing';

        // Rebuilt rather than reset: a countdown registers with the world's set on `start`, and
        // last round's has already fired and taken itself back out.
        const clock = new Countdown(this.roundSeconds, () => this.#endRound());
        clock.start();
        this.#clock = clock;
        this.secondsLeft = Math.ceil(clock.remaining);
        this.#dropping = every(this.leafInterval, () => this.#drop());
    }

    /** `game.random`, never `Math.random`: the snapshot store captures every draw, so a replay agrees. */
    #drop(): void {
        const game = this.host;
        if (this.phase !== 'playing') return;
        const slots = heldSlots(game.players);
        if (slots.length === 0) return;
        const band = dropBand(game.bounds);
        spawnLeaf(game, game.random.between(band.low, band.high), game.random.pick(slots));
    }

    #endRound(): void {
        if (this.phase !== 'playing') return;
        this.#stopRound();
        this.phase = 'results';
        this.secondsLeft = this.resultsSeconds;

        const game = this.host;
        for (const player of game.players) {
            const scored = this.scores.of(player);
            // Always with the player: nothing in a leaderboard can infer whose score it is.
            this.board.submit(scored, player);
            const profile = player.getScript(Profile);
            if (profile === null) continue;
            profile.lifetimeLeaves += scored;
            profile.bestRound = Math.max(profile.bestRound, scored);
            profile.ready = false;
        }

        const [winner] = this.scores.top(1);
        this.winnerName = winner?.name ?? '';
        this.#recount();

        // `spectate` destroys the avatar and nulls it, which is why every loop over `game.players`
        // guards on `hasAvatar` before reaching for one.
        for (const leaf of liveLeaves(game)) leaf.destroy();
        for (const player of game.players) player.spectate();
        if (winner) this.#crown(winner);
    }

    /**
     * The winner's crown, whose art is declared the first time one is needed.
     *
     * Declared before the spawn, and so before the send that journals it — a node created against a
     * table that does not hold its template draws the placeholder and keeps it.
     */
    #crown(winner: Player): void {
        if (!this.#crowned && declareCrown()) this.#crowned = true;
        // No `setScale`: the art is a group template's CHILDREN and only position and visibility
        // inherit, so scaling this pivot would resize nothing. Its size lives in the declaration.
        const crown = this.host.spawn(CROWN_TEMPLATE, avatarX(slotOf(winner)), AVATAR_Y + 52);
        crown.layer = MARKER_LAYER;
        crown.tag(CROWN_TAG);
    }

    #reopen(): void {
        if (this.phase !== 'results') return;
        const game = this.host;
        for (const crown of game.find({ tag: CROWN_TAG })) crown.destroy();
        for (const player of game.players) {
            // `respawn`, never `spawn`: a tab that joined DURING the results already has an avatar,
            // and spawning a second would leave the first alive and owned with nothing referring to it.
            player.respawn();
            placeAvatar(player);
        }
        this.winnerName = '';
        this.secondsLeft = 0;
        this.phase = 'lobby';
        this.#recount();
    }

    #stopRound(): void {
        this.#clock?.pause();
        this.#clock = null;
        this.#dropping?.();
        this.#dropping = null;
    }

    /**
     * The one-second tick: it publishes the round clock, and it times the results dwell.
     *
     * The dwell is counted here rather than off a second timer because this callback already belongs
     * to the Game's scope — a timer registered inside a countdown's `onZero` would be scoped to
     * whatever invocation happened to be ambient there.
     */
    #second(): void {
        if (this.phase === 'playing') {
            const remaining = Math.max(0, Math.ceil(this.#clock?.remaining ?? 0));
            if (remaining !== this.secondsLeft) this.secondsLeft = remaining;
            return;
        }
        if (this.phase !== 'results') return;
        const next = this.secondsLeft - 1;
        this.secondsLeft = Math.max(0, next);
        if (next <= 0) this.#reopen();
    }

    #recount(excluding?: string): void {
        const players = this.host.players.filter((player) => player.id !== excluding);
        this.playerCount = players.length;
        this.readyCount = players.filter(
            (player) => player.getScript(Profile)?.ready === true,
        ).length;
    }
}

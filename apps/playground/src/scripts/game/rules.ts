// The Game's own script: the roster, the match clock, the drift pass and the scores.
//
// Every `@serverState` field below is REASSIGNED wherever it changes. The decorator installs an
// accessor pair and only the setter marks the replication channel, so a value mutated in place
// would replicate nothing while looking from here exactly as though it had.

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
    AVATAR_SCALE,
    AVATAR_Y,
    CROWN_TEMPLATE,
    LEAF_INTERVAL,
    MARKER_LAYER,
    MAX_PLAYERS,
    RESULTS_SECONDS,
    ROUND_SECONDS,
    STATE_BEST,
    STATE_LIFETIME,
    STATE_READY,
    STATE_SLOT,
    WIDGET_READY,
    avatarX,
    tintSlot,
} from '../globals.js';
import { declareCrown, publishRules } from '../session.js';
import { readState, writeState } from '../state.js';
import { Clicker } from '../players/clicker.js';
import { Profile } from '../players/profile.js';
import { dropBand, hasExited, liveLeaves, spawnLeaf, stepLeaf } from '../templates/leaf/leaf.js';

/** The tag the reopen sweeps last round's crown by. */
const CROWN_TAG = 'crown';

/** The palette seat the rules gave this player, or seat 0 before `Profile` has been attached. */
function slotOf(player: Player): number {
    return tintSlot(readState<number>(player, STATE_SLOT) ?? 0);
}

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

    /**
     * Plain fields, never `@serverState`.
     *
     * A wrapper marks its own channel from inside its mutating methods, and decorating one would
     * route it through the accessor path and skip the binding that installs that mark. A client
     * holding no scripts revives both from the payload's own tag, so `of` and `top` answer there.
     */
    scores = new Scoreboard();
    board = new Leaderboard({ order: 'high' });

    /** The round clock. Rebuilt per round, because a spent one has already fired and deregistered. */
    #clock: Countdown | null = null;
    /** Cancels the leaf drop; null outside a round. */
    #dropping: (() => void) | null = null;
    /** Whether the crown's art has been announced, so the declaration happens once per world. */
    #crowned = false;

    @onStart
    begin(): void {
        publishRules(this);
        // Registered on the Game's own host scope, so it lives exactly as long as the world does.
        // One write a second rather than one a tick: the value is a whole second, and marking the
        // channel sixty times to send the same integer is the shape of a wire nobody profiled.
        every(1, () => this.#second());
    }

    @onEnd
    end(): void {
        this.#stopRound();
        publishRules(null);
    }

    /**
     * `spawn()` instantiates the Player template, which is where `Runner` and `Harvester` are
     * declared: it owns the avatar to this player, which is what puts it inside that client's
     * predicted scope and what makes the server reap it when the tab closes.
     */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Clicker);
        // This player's saved record is already in the cache: the server reads it before
        // `@onPlayerJoin` runs, so the hoist seeds `Profile` from the save rather than from its
        // initializers — which is exactly why `ready` is cleared on the next line.
        player.addScript(Profile);
        writeState(player, STATE_READY, false);
        writeState(player, STATE_SLOT, this.#freeSlot(player));
        player.spawn();
        this.#place(player);
        this.#recount();
    }

    /**
     * The roster still holds the player leaving when this runs — the removal is last, so both
     * `@onEnd` and this can still read them — which is why the recount is told who to leave out.
     */
    @onPlayerLeave
    leave(ctx: Ctx): void {
        this.#recount(ctx.player?.id);
        // A round with nobody left in it ends rather than dropping leaves into an empty world.
        if (this.playerCount === 0 && this.phase === 'playing') this.#endRound();
        // The tab that had not readied may be the one that just left, which would otherwise leave
        // the lobby reading "2/2 ready" with nothing starting until somebody pressed twice.
        else this.#startIfEveryoneReady();
    }

    /**
     * The lobby's one command, and the only creator-facing client→server channel that is not an
     * input action: a press rides the interaction frame with the connection's own player attached,
     * so `ctx.player` here is engine-supplied rather than something a frame could claim.
     */
    @onPress(WIDGET_READY)
    ready(ctx: Ctx): void {
        const player = ctx.player;
        if (!player || this.phase !== 'lobby') return;
        writeState(player, STATE_READY, readState<boolean>(player, STATE_READY) !== true);
        this.#recount();
        this.#startIfEveryoneReady();
    }

    @onUpdate
    drift(ctx: Ctx): void {
        const game = this.host;
        const bounds = game.bounds;

        for (const leaf of liveLeaves(game)) {
            const next = stepLeaf(leaf.position.x, leaf.rotation, ctx.dt);
            // The backstop, not the reap: `Leaf` composts it on the region edge well before here,
            // and reaching this means it crossed the whole strip inside a single tick.
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
        // The player is passed explicitly: the acting-player ambient is only available inside a
        // handler driven by one, and `Scoreboard.add` throws rather than silently losing a score.
        this.scores.add(points, player);
    }

    /** @internal — a leaf nobody caught. */
    noteWasted(): void {
        if (this.phase !== 'playing') return;
        this.wasted = this.wasted + 1;
    }

    /** @internal — the palette seat of every player currently seated, for the badge draw. */
    activeSlots(): number[] {
        return this.host.players.map((player) => slotOf(player));
    }

    /**
     * The lowest palette seat no live player holds.
     *
     * Not `player.index`, which the engine allocates from a counter a leave never lowers: after
     * eight tabs have come and gone a ninth takes index 8, and wrapping it would land on the hue
     * and the spawn point of whoever still holds index 0.
     */
    #freeSlot(joining: Player): number {
        // The joining player is already on the roster and already carries `Profile`'s initializer,
        // so counting their own default would push the first player of a session off seat zero.
        const taken = new Set(
            this.host.players
                .filter((player) => player.id !== joining.id)
                .map((player) => readState<number>(player, STATE_SLOT)),
        );
        for (let slot = 0; slot < MAX_PLAYERS; slot++) {
            if (!taken.has(slot)) return slot;
        }
        return 0;
    }

    /** Puts a freshly spawned avatar where it belongs, at the size its own reach implies. */
    #place(player: Player): void {
        if (!player.hasAvatar) return;
        player.avatar.setScale(AVATAR_SCALE);
        player.teleportTo(avatarX(slotOf(player)), AVATAR_Y);
    }

    /**
     * Everyone connected, and at least one of them.
     *
     * A solo tab can still start a round, which is what makes this runnable without a second
     * browser open — and a joiner who has not readied holds the round up, which is what makes the
     * count worth showing.
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

    /**
     * One leaf, at a height and in a colour the world's own PRNG chose.
     *
     * `game.random`, never `Math.random`: every draw is captured by the snapshot store, so a
     * replayed tick draws the same number and the authority stays reproducible.
     */
    #drop(): void {
        const game = this.host;
        if (this.phase !== 'playing') return;
        const slots = this.activeSlots();
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
            // Always with the player: nothing in a leaderboard can infer whose score it is, so it
            // throws rather than dropping one.
            this.board.submit(scored, player);
            writeState(
                player,
                STATE_LIFETIME,
                (readState<number>(player, STATE_LIFETIME) ?? 0) + scored,
            );
            writeState(
                player,
                STATE_BEST,
                Math.max(readState<number>(player, STATE_BEST) ?? 0, scored),
            );
            writeState(player, STATE_READY, false);
        }

        const [winner] = this.scores.top(1);
        this.winnerName = winner?.name ?? '';
        this.#recount();

        // The stage clears and everyone watches: `spectate` destroys the avatar and nulls it, which
        // is why every loop over `game.players` guards on `hasAvatar` before reaching for one.
        for (const leaf of liveLeaves(game)) leaf.destroy();
        for (const player of game.players) player.spectate();
        if (winner) this.#crown(winner);
    }

    /**
     * The winner's crown, whose art is declared the first time one is needed.
     *
     * A template nothing has spawned needs no entry at boot, and announcing it here is the path a
     * connected peer's `manifest` envelope and a later joiner's welcome have to agree about. It runs
     * before the spawn, and so before the send that journals it — a node created against a table
     * that does not hold its template draws the placeholder and keeps it.
     */
    #crown(winner: Player): void {
        if (!this.#crowned && declareCrown()) this.#crowned = true;
        // No `setScale` here: the crown's art is a group template's CHILDREN, and only position and
        // visibility inherit — scaling this pivot would resize nothing. Its size lives in the
        // declaration the host announces, which is the only place it can.
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
            // and spawning a second would leave the first alive and owned with nothing referring to
            // it. Respawn destroys whatever is there first, and does the right thing with nothing.
            player.respawn();
            this.#place(player);
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
     * The one-second tick: it publishes the round clock, and it is what times the results dwell.
     *
     * The dwell is counted here rather than off a second timer because this callback already
     * belongs to the Game's scope — a timer registered from inside a countdown's `onZero` would be
     * scoped to whatever invocation happened to be ambient there.
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
            (player) => readState<boolean>(player, STATE_READY) === true,
        ).length;
    }
}

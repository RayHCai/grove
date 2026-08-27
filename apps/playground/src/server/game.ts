// The authoritative game: the only file in this app that carries decorator syntax.
//
// It is compiled by `tsconfig.server.json` and never enters the browser bundle, because `tsc` is
// the only tool in this repo that lowers TC39 standard decorators — Vite's oxc transform passes
// them through untouched and Node then refuses to parse them.
//
// Nothing here reads core's `game` module const. Core keeps ONE module-global runtime, and a
// `GameClient` in the same process would repoint it; every path below goes through `this.host` or
// the Game captured at start, so the world a handler writes is always its own.

import type { Ctx, Entity, Game, Player } from '@platform/core';
import {
    Countdown,
    Leaderboard,
    Scoreboard,
    ServerScript,
    every,
    onClick,
    onCollide,
    onEnd,
    onEnter,
    onEvent,
    onEventHold,
    onExit,
    onPlayerJoin,
    onPlayerLeave,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/core';
import { bounds as makeBounds } from '@platform/math';
import type { MatchPhase } from '../shared.js';
import {
    ACTION_AIM_Y,
    ACTION_CLEAR,
    ACTION_SPAWN,
    AVATAR_HALF,
    AVATAR_SCALE,
    AVATAR_Y,
    CROWN_TEMPLATE,
    LEAF_HALF,
    LEAF_INTERVAL,
    LEAF_SCALE,
    LEAF_TAG,
    LEAF_TEMPLATE,
    MAX_PLAYERS,
    REGION_BONUS,
    REGION_COMPOST,
    RESULTS_SECONDS,
    ROUND_SECONDS,
    STATE_BADGE_SLOT,
    STATE_BEST,
    STATE_LIFETIME,
    STATE_READY,
    STATE_RIPE,
    STATE_SLOT,
    WIDGET_READY,
    avatarX,
    decodeAim,
    markerTemplate,
    tintSlot,
} from '../shared.js';
import {
    LEAF_LAYER,
    MARKER_LAYER,
    MARKER_OFFSET_Y,
    MARKER_OPACITY,
    MARKER_SCALE,
    RIPE_SCALE,
    clampToWorld,
    dropBand,
    harvestValue,
    hasExited,
    popValue,
    spawnX,
    stepLeaf,
} from './leaf.js';

/** The tag the reopen sweeps last round's crown by. */
const CROWN_TAG = 'crown';

/**
 * The world every handler writes, captured once at start.
 *
 * A player-hosted or entity-hosted script has no route back to the Game — neither `Player` nor
 * `Entity` holds a reference to one — and core's `game` const reads a module-global that a
 * co-located client would repoint.
 */
let world: Game | null = null;

/** The one live `Rules`, so a leaf's own script can score without reaching for the Game. */
let rules: Rules | null = null;

/**
 * How the host announces the crown's art, injected because `declareVisuals` belongs to the
 * `GameServer` and a script has no route to the process that built it.
 */
let declareCrown: (() => void) | null = null;

/** Called by the composition root with whatever announces the crown template, or `null` to drop it. */
export function onCrownNeeded(declare: (() => void) | null): void {
    declareCrown = declare;
}

/** Publishes the two module slots above, which is the whole reason they exist. */
function publish(game: Game | null, live: Rules | null): void {
    world = game;
    rules = live;
}

/** Reads a `@serverState` field off a host facade, which declares no such member. */
function stateOf<T>(host: object, field: string): T | undefined {
    return (host as unknown as Record<string, unknown>)[field] as T | undefined;
}

/** Writes one, for the same reason. */
function setState(host: object, field: string, value: unknown): void {
    (host as unknown as Record<string, unknown>)[field] = value;
}

/** The palette seat the rules gave this player, or slot 0 before `Profile` has been attached. */
function slotOf(player: Player): number {
    return tintSlot(stateOf<number>(player, STATE_SLOT) ?? 0);
}

/**
 * Spawns one leaf, plus the badge parented above it in the slot it is ripe for.
 *
 * The tint rides the badge's template, so `badgeSlot` picks which one — a transform diff carries no
 * colour, and a template is the only per-entity route a tint has to the wire. The slot is written
 * to the leaf's own `@serverState` as well, because the scoring rule needs the number and a
 * template key is not one.
 *
 * Ownership is deliberately left unset. `GameServer` destroys every entity whose `ownerId` matches
 * a departing player, so an owned leaf would vanish from every other tab the moment the tab that
 * dropped it closed — and a leaf belongs to the round rather than to a person.
 */
function spawnLeaf(game: Game, worldY: number, badgeSlot: number): Entity {
    const bounds = game.bounds;
    const leaf = game.spawn(LEAF_TEMPLATE, spawnX(bounds), clampToWorld(worldY, bounds));
    leaf.tag(LEAF_TAG);
    leaf.setRotation(0);
    leaf.setScale(LEAF_SCALE);
    leaf.layer = LEAF_LAYER;
    // Assigned here and nowhere else: nothing in core, the manifest or the template system writes a
    // collider, so `@onCollide` and `getTouching` answer nothing at all until one exists.
    leaf.collider = {
        enabled: true,
        isTrigger: true,
        bounds: makeBounds(-LEAF_HALF, LEAF_HALF, LEAF_HALF, -LEAF_HALF),
    };
    // The template attached `Leaf` inside `spawn`, so the accessor this writes through is already
    // hoisted onto the facade — attaching is synchronous, and only `@onStart` waits for a pass.
    setState(leaf, STATE_BADGE_SLOT, badgeSlot);

    // Follows its parent's position but inherits neither its rotation nor its scale, which is what
    // keeps the badge upright over a tumbling leaf — and gives the inspector a real two-level tree.
    const badge = game.spawn(markerTemplate(badgeSlot), 0, MARKER_OFFSET_Y);
    badge.setScale(MARKER_SCALE);
    badge.opacity = MARKER_OPACITY;
    badge.layer = MARKER_LAYER;
    badge.attachTo(leaf);
    return leaf;
}

function liveLeaves(game: Game): Entity[] {
    return game.find({ tag: LEAF_TAG });
}

/**
 * The Game-hosted rules: the roster, the match clock, the drift pass and the scores.
 *
 * Every `@serverState` field below is REASSIGNED wherever it changes. The decorator installs an
 * accessor pair and only the setter marks the replication channel, so a value mutated in place
 * would replicate nothing while looking from here exactly as though it had.
 */
export class Rules extends ServerScript<Game> {
    /** Inspector values, written by `applyProps` between construction and the `@serverState` hoist. */
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
    /** Whether the crown's art has been announced, so the declaration happens once per process. */
    #crowned = false;

    @onStart
    begin(): void {
        publish(this.host, this);
        // Registered on the Game's own host scope, so it lives exactly as long as the world does.
        // One write a second rather than one a tick: the value is a whole second, and marking the
        // channel sixty times to send the same integer is the shape of a wire nobody profiled.
        every(1, () => this.#second());
    }

    @onEnd
    end(): void {
        this.#stopRound();
        publish(null, null);
    }

    /**
     * Input reaches a player host and an avatar host, never the Game host, so the click handler
     * has to be attached per player rather than declared here.
     *
     * `spawn()` instantiates the Player template, which is where `Runner` and `Harvester` are
     * declared: it owns the avatar to this player, which is what puts it inside that client's
     * predicted scope and what makes `GameServer` reap it when the tab closes.
     */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Clicker);
        // This player's saved record is already in the cache: the server reads it before
        // `@onPlayerJoin` runs, so the hoist seeds these fields from the save rather than from
        // their initializers.
        player.addScript(Profile);
        // Which is exactly why `ready` is cleared here. It is a per-session answer that happens to
        // live on the persisted host, so a tab that closed the moment after readying would rejoin
        // already readied — and the next press would un-ready them rather than start a round.
        setState(player, STATE_READY, false);
        setState(player, STATE_SLOT, this.#freeSlot(player));
        player.spawn();
        this.#place(player);
        this.#recount();
    }

    /**
     * The lowest palette seat no live player holds.
     *
     * Not `player.index`, which core allocates from a counter a leave never lowers: after eight
     * tabs have come and gone a ninth takes index 8, and `tintSlot` would wrap it onto the hue and
     * the spawn point of whoever still holds index 0.
     */
    #freeSlot(joining: Player): number {
        // The joining player is already on the roster and already carries `Profile`'s initializer,
        // so counting their own default would push the first player of a session off slot zero.
        const taken = new Set(
            this.host.players
                .filter((player) => player.id !== joining.id)
                .map((player) => stateOf<number>(player, STATE_SLOT)),
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
        setState(player, STATE_READY, stateOf<boolean>(player, STATE_READY) !== true);
        this.#recount();
        this.#startIfEveryoneReady();
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

    /** @internal — a leaf's own script scores through here, so the wrapper has one writer. */
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

    /** @internal — the tint slot of every player currently seated, for the badge draw. */
    activeSlots(): number[] {
        return this.host.players.map((player) => slotOf(player));
    }

    #startRound(): void {
        const game = this.host;
        for (const leaf of liveLeaves(game)) leaf.destroy();
        this.scores.reset();
        this.wasted = 0;
        this.round = this.round + 1;
        this.winnerName = '';
        this.phase = 'playing';

        // Rebuilt rather than reset: a countdown registers with the runtime's set on `start`, and
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
            setState(
                player,
                STATE_LIFETIME,
                (stateOf<number>(player, STATE_LIFETIME) ?? 0) + scored,
            );
            setState(
                player,
                STATE_BEST,
                Math.max(stateOf<number>(player, STATE_BEST) ?? 0, scored),
            );
            setState(player, STATE_READY, false);
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
     * connected peer's `manifest` envelope and a later joiner's `Welcome` have to agree about. It
     * runs before the spawn, and so before the send that journals it — a node created against a
     * table that does not hold its template draws the placeholder and keeps it.
     */
    #crown(winner: Player): void {
        if (!this.#crowned && declareCrown !== null) {
            declareCrown();
            this.#crowned = true;
        }
        // No `setScale` here: the crown's art is a group template's CHILDREN, and only position and
        // visibility inherit — scaling this pivot would move nothing. Its size lives in the
        // declaration `host.ts` announces, which is the only place it can.
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
            (player) => stateOf<boolean>(player, STATE_READY) === true,
        ).length;
    }
}

/**
 * One per connected player: it turns that player's input into world changes.
 *
 * The work happens on the update pass rather than in the press handler because a press is
 * dispatched before that tick's axis samples are, so the click's y is only current one pass later.
 */
export class Clicker extends ServerScript<Player> {
    #aimY = 0;
    #pending = 0;
    #clearing = false;

    @onEventHold(ACTION_AIM_Y)
    aim(ctx: Ctx): void {
        const value = ctx.value;
        if (value === undefined) return;
        this.#aimY = decodeAim(value);
    }

    @onEvent(ACTION_SPAWN)
    click(): void {
        this.#pending += 1;
    }

    @onEvent(ACTION_CLEAR)
    clear(): void {
        this.#clearing = true;
    }

    /**
     * Planting is a LOBBY affordance. During a round the leaves are the round's to drop, and a tab
     * that could conjure its own would be scoring against a supply nobody else had.
     */
    @onUpdate
    apply(): void {
        const game = world;
        const live = rules;
        if (game === null || live === null) return;
        const lobby = live.phase === 'lobby';

        if (this.#clearing) {
            this.#clearing = false;
            if (lobby) for (const leaf of liveLeaves(game)) leaf.destroy();
        }

        while (this.#pending > 0) {
            this.#pending -= 1;
            if (lobby) spawnLeaf(game, this.#aimY, slotOf(this.host));
        }
    }
}

/**
 * One per connected player, and the only thing here that outlives a session.
 *
 * `GameServer` reads this player's saved record before `@onPlayerJoin` runs and writes it back when
 * the socket closes, keyed by the identity the host supplied — so these three fields come back on a
 * rejoin under the same `?player=` id with nothing else to arrange. Player-hosted, so they
 * replicate to their owner and to nobody else, which is the scope a personal total wants.
 */
export class Profile extends ServerScript<Player> {
    @serverState lifetimeLeaves = 0;
    @serverState bestRound = 0;
    /** Per-session, and cleared at the join for that reason — the record it rides is persisted. */
    @serverState ready = false;
    /** The palette seat the rules assigned, which is also this tab's own spawn point. */
    @serverState slot = 0;
}

/**
 * On every avatar, from the Player template: the reach that turns walking into harvesting.
 *
 * `@onCollide` is the ENTER edge of an overlap and fires once per tag on the other body, so a leaf
 * walked into scores once however many ticks the two stay touching.
 */
export class Harvester extends ServerScript<Entity> {
    @onStart
    equip(): void {
        this.host.collider = {
            enabled: true,
            isTrigger: true,
            bounds: makeBounds(-AVATAR_HALF, AVATAR_HALF, AVATAR_HALF, -AVATAR_HALF),
        };
    }

    @onCollide(LEAF_TAG)
    pick(ctx: Ctx): void {
        const leaf = ctx.other;
        const live = rules;
        const player = this.host.owner;
        // Two avatars can reach one leaf on the same tick and both handlers run: the liveness check
        // is what stops the second one scoring a leaf the first already took.
        if (!leaf || !leaf.alive || live === null || player === null) return;

        const slot = stateOf<number>(leaf, STATE_BADGE_SLOT);
        live.award(
            player,
            harvestValue({
                ripe: stateOf<boolean>(leaf, STATE_RIPE) === true,
                badgedForHarvester: slot === slotOf(player),
            }),
        );
        leaf.destroy();
    }
}

/**
 * On every leaf, from the leaf template: what the two regions do to it, and what a click does.
 *
 * `@onEnter` / `@onExit` dispatch to ENTITY hosts only, which is why this rides the leaf rather
 * than the Game — a region handler on a Game-hosted script never fires at all.
 */
export class Leaf extends ServerScript<Entity> {
    /** Entity-hosted, so it replicates: the browser reads it to explain why a leaf draws large. */
    @serverState ripe = false;
    @serverState badgeSlot = -1;

    @onEnter(REGION_BONUS)
    ripen(): void {
        this.ripe = true;
        this.host.setScale(RIPE_SCALE);
    }

    @onExit(REGION_BONUS)
    wither(): void {
        this.ripe = false;
        this.host.setScale(LEAF_SCALE);
    }

    /**
     * The strip a leaf nobody caught wilts into. It is destroyed HERE rather than at the world's
     * edge, which is what makes the drift pass's own reap a backstop rather than the rule.
     */
    @onEnter(REGION_COMPOST)
    compost(): void {
        rules?.noteWasted();
        this.host.destroy();
    }

    /**
     * A pointer hit the browser resolved against its own camera, which no authority can recompute.
     *
     * The server checks only that the entity is alive; whether the clicking player could plausibly
     * reach it is this handler's business, and here the answer is deliberately that they need not —
     * popping is the long-range steal, and it is worth a point rather than a harvest.
     */
    @onClick
    pop(ctx: Ctx): void {
        const live = rules;
        const player = ctx.player;
        if (live === null || !player || live.phase !== 'playing' || !this.host.alive) return;
        live.award(player, popValue());
        this.host.destroy();
    }
}

/** Drops the captured world, so a second server in one process does not inherit the first's. */
export function resetWorld(): void {
    publish(null, null);
    declareCrown = null;
}

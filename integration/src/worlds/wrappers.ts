// A world whose whole game is the stateful wrappers: a scoreboard, two leaderboards ordered against
// each other, a team, one inventory per player, a countdown and the store behind `player.storage`.
//
// Every verb is reached by pressing a widget, so each call runs inside a handler with an
// engine-supplied `ctx.player` — which is the only place `Scoreboard.add`'s acting-player default
// exists at all. The readings are `@serverState`, so a test asserts on what a CLIENT was told rather
// than on a return value taken from the authority.
//
// The wrappers ride the wire as their own serialized form beside those readings, so a tab ends up
// holding real `Scoreboard` and `Team` objects and not only the numbers a handler copied out.

import type { Ctx, Game, Player } from '@platform/engine';
import {
    Countdown,
    Inventory,
    Leaderboard,
    Scoreboard,
    ServerScript,
    Team,
    onPlayerJoin,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/engine';
import { TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_VAULT = 'vault';
export const SCRIPT_PACK = 'pack';

export const TEAM_RED = 'red';
export const ITEM_KEY = 'key';
export const ITEM_GEM = 'gem';

/** What one `award` press is worth, and what `setScore` overwrites a whole total with. */
export const AWARD = 10;
export const SET_TO = 4;

export const STORE_KEY = 'visits';
export const STORE_VALUE = 7;
/** What `stored` reads before the store has answered, and for a key it holds nothing under. */
export const UNREAD = -1;

/** Long enough that a test can settle a press, read a partial remainder and still pause it. */
export const COUNTDOWN_SECONDS = 1;

/** One widget per verb: a press names the call, and the name is what the test reads back. */
export const W = {
    award: 'award',
    setScore: 'set-score',
    resetScores: 'reset-scores',
    bank: 'bank',
    joinTeam: 'join-team',
    leaveTeam: 'leave-team',
    stock: 'stock',
    spend: 'spend',
    emptyBag: 'empty-bag',
    startClock: 'start-clock',
    pauseClock: 'pause-clock',
    keep: 'keep',
    forget: 'forget',
    recall: 'recall',
} as const;

/** Game-hosted readings, named so none of them collides with a member `Game` already owns. */
export const S = {
    mine: 'mine',
    leaders: 'leaders',
    banked: 'banked',
    floor: 'floor',
    rank: 'rank',
    podium: 'podium',
    squad: 'squad',
    onTeam: 'onTeam',
    remains: 'remains',
    ticking: 'ticking',
    rang: 'rang',
} as const;

/** Player-hosted readings, which reach that player's own tab and no other. */
export const P = {
    keys: 'keys',
    gems: 'gems',
    carrying: 'carrying',
    owner: 'owner',
    stored: 'stored',
} as const;

/** The wrapper fields themselves, which replicate with no decorator on them. */
export const F = {
    scores: 'scores',
    best: 'best',
    worst: 'worst',
    red: 'red',
    bag: 'bag',
} as const;

/**
 * The player the next `Pack` is built for.
 *
 * `Inventory` takes a `Player`, wiring binds only the wrappers a field initializer has already
 * built, and that initializer runs before `this.host` is assigned — so a slot the join handler fills
 * is the one way to name the owner from inside one.
 */
let joining: Player | null = null;

export class Pack extends ServerScript<Player> {
    readonly bag = new Inventory(joining!);

    @serverState keys = 0;
    @serverState gems = 0;
    @serverState carrying = false;
    /** Read back off the wrapper, so the constructor argument is proven rather than restated. */
    @serverState owner = '';
    /** What `player.storage` last answered; `UNREAD` until something has. */
    @serverState stored = UNREAD;

    /** One place the inventory is observed from, so no press has to remember all four readings. */
    read(): void {
        this.keys = this.bag.count(ITEM_KEY);
        this.gems = this.bag.count(ITEM_GEM);
        this.carrying = this.bag.has(ITEM_KEY);
        this.owner = this.bag.player.name;
    }
}

export class Vault extends ServerScript<Game> {
    /** Never `@serverState`: a wrapper marks its own channel from inside its mutating methods. */
    readonly scores = new Scoreboard();
    readonly best = new Leaderboard({ order: 'high' });
    /** The same submissions under the other order, so neither board can stand in for both. */
    readonly worst = new Leaderboard({ order: 'low' });
    readonly red = new Team(TEAM_RED);

    @serverState mine = 0;
    @serverState leaders = '';
    @serverState banked = 0;
    @serverState floor = 0;
    @serverState rank = 0;
    @serverState podium = '';
    @serverState squad = '';
    @serverState onTeam = false;
    /** A countdown replicates nothing of itself, so these three are all a tab is ever told of one. */
    @serverState remains = 0;
    @serverState ticking = false;
    @serverState rang = 0;

    #clock: Countdown | null = null;

    @onStart
    begin(): void {
        // Built inside a handler so a throw in `onZero` is charged to this script; a field
        // initializer runs under no invocation and the breaker would have nothing to name.
        this.#clock = new Countdown(COUNTDOWN_SECONDS, () => {
            this.rang = this.rang + 1;
        });
    }

    @onPlayerJoin
    seat(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        joining = player;
        player.addScript(Pack);
        joining = null;
        player.spawn();
        const pack = player.getScript(Pack);
        if (!pack) return;
        // The hoist seeded this from the last session's record, and the reading is about what the
        // store answers THIS one — so it starts unread however much was banked.
        pack.stored = UNREAD;
        pack.read();
    }

    @onPress(W.award)
    award(ctx: Ctx): void {
        // No player named: inside a press the acting-player ambient is whoever pressed it.
        this.scores.add(AWARD);
        this.#readScores(ctx.player);
    }

    @onPress(W.setScore)
    overwrite(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.scores.set(SET_TO, player);
        this.#readScores(player);
    }

    @onPress(W.resetScores)
    wipe(ctx: Ctx): void {
        this.scores.reset();
        this.#readScores(ctx.player);
    }

    @onPress(W.bank)
    bank(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        const points = this.scores.of(player);
        this.best.submit(points, player);
        this.worst.submit(points, player);
        this.#readBoards(player);
    }

    @onPress(W.joinTeam)
    enlist(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.red.add(player);
        this.#readTeam(player);
    }

    @onPress(W.leaveTeam)
    discharge(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.red.remove(player);
        this.#readTeam(player);
    }

    @onPress(W.stock)
    stock(ctx: Ctx): void {
        const pack = ctx.player?.getScript(Pack);
        if (!pack) return;
        pack.bag.add(ITEM_KEY, 2);
        // No count, so the default of one is what lands.
        pack.bag.add(ITEM_GEM);
        pack.read();
    }

    @onPress(W.spend)
    spend(ctx: Ctx): void {
        const pack = ctx.player?.getScript(Pack);
        if (!pack) return;
        pack.bag.remove(ITEM_KEY);
        pack.read();
    }

    @onPress(W.emptyBag)
    emptyBag(ctx: Ctx): void {
        const pack = ctx.player?.getScript(Pack);
        if (!pack) return;
        pack.bag.clear();
        pack.read();
    }

    @onPress(W.startClock)
    startClock(): void {
        this.#clock?.start();
    }

    @onPress(W.pauseClock)
    pauseClock(): void {
        this.#clock?.pause();
    }

    /** `Storage` is a promise-returning seam, so the reading is written once the write has landed. */
    @onPress(W.keep)
    async keep(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (!player) return;
        await player.storage.set(STORE_KEY, STORE_VALUE);
        await this.#recall(player);
    }

    @onPress(W.forget)
    async drop(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (!player) return;
        await player.storage.delete(STORE_KEY);
        await this.#recall(player);
    }

    @onPress(W.recall)
    async reread(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (player) await this.#recall(player);
    }

    // Written through the player's own `Pack`, since a store read is per-player and a Game-hosted
    // field would tell every tab what one of them asked for.
    async #recall(player: Player): Promise<void> {
        const held = await player.storage.get(STORE_KEY);
        const pack = player.getScript(Pack);
        if (pack) pack.stored = typeof held === 'number' ? held : UNREAD;
    }

    /** One write per change: `remaining` moves every tick and a mark per tick is a wire nobody profiled. */
    @onUpdate
    watch(): void {
        const clock = this.#clock;
        if (!clock) return;
        const left = Math.round(clock.remaining * 100) / 100;
        if (left !== this.remains) this.remains = left;
        if (clock.running !== this.ticking) this.ticking = clock.running;
    }

    #readScores(player: Player | undefined): void {
        this.mine = player ? this.scores.of(player) : 0;
        this.leaders = this.scores
            .top(2)
            .map((p) => p.name)
            .join(',');
    }

    #readBoards(player: Player): void {
        this.banked = this.best.of(player);
        this.floor = this.worst.of(player);
        this.rank = this.best.rankOf(player);
        this.podium = this.best
            .top(2)
            .map((entry) => `${entry.player.name}:${entry.score}`)
            .join(',');
    }

    #readTeam(player: Player): void {
        this.onTeam = this.red.has(player);
        const roster = this.red.players
            .map((p) => p.name)
            .toSorted()
            .join('/');
        this.squad = `${this.red.name}:${roster}`;
    }
}

export const WRAPPERS_WORLD: World = defineWorld({
    id: 'wrappers',
    scripts: [
        {
            id: SCRIPT_VAULT,
            export: 'Vault',
            path: 'src/worlds/wrappers.ts',
            location: 'server',
            host: 'game',
            ctor: Vault,
        },
        // Named in no attachment list: a player is not a placed entity, so `Vault` attaches this at
        // the join. Declaring it here is what makes the manifest the whole inventory of scripts.
        {
            id: SCRIPT_PACK,
            export: 'Pack',
            path: 'src/worlds/wrappers.ts',
            location: 'server',
            host: 'player',
            ctor: Pack,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR)],
    gameScripts: [attach(SCRIPT_VAULT)],
});

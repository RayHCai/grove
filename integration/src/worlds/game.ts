// The world the `Game` facade is asked about: a roster, a fixed extent, an authored region, two
// rocks, a sentinel that hops and one body that drifts under its own tick.
//
// Every answer is a `@serverState` field rather than a return value, so a test reads what a CLIENT
// was told, and the geometry is chosen so every count below is arithmetic — including the hop,
// which is the only way to catch `asSeen` disagreeing with the live world it was asked about.

import type { Ctx, Entity, Game, Player, Vec3 } from '@platform/engine';
import {
    ServerScript,
    game,
    onPlayerJoin,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/engine';
import type { ProjectBounds } from '@platform/project';
import { templateId } from '@platform/project';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const TEMPLATE_ROCK = 'rock';
export const TEMPLATE_PROBE = 'probe';
export const TEMPLATE_SENTINEL = 'sentinel';
export const TEMPLATE_DRIFTER = 'drifter';

export const TAG_ROCK = 'rock';
/** Only the rock outside the yard, so a query can name it without asking where it stands. */
export const TAG_OUTER = 'outer';
export const TAG_SENTINEL = 'sentinel';
export const TAG_MARKED = 'marked';

/** Narrower than the harness default, so reading it back proves `bounds` is the AUTHORED extent. */
export const GAME_BOUNDS: ProjectBounds = { left: -240, right: 240, top: 140, bottom: -140 };

export const REGION_YARD = 'yard';
export const YARD: ProjectBounds = { left: 100, right: 200, top: 100, bottom: 40 };

export const AVATAR_AT = { x: -180, y: -100 };
export const ROCK_IN = { x: 150, y: 70 };
export const ROCK_OUT = { x: -60, y: 0 };
export const SENTINEL_AT = { x: 60, y: -100 };
/** Where the sentinel hops to: inside the yard, and far enough that no radius holds both points. */
export const SENTINEL_TO = { x: 150, y: 60 };
/** Above the yard's top edge, so a drifter crossing the yard's x range never enters it. */
export const DRIFT_AT = { x: -100, y: 130 };
export const DRIFT_SPEED = 20;

/** Small enough that only the rock the query is centred on falls inside it. */
export const NEAR_TIGHT = 40;
/** Longer than the world's diagonal, so this radius must answer with every entity there is. */
export const NEAR_WIDE = 400;

export const SEED = 1234;
export const LEDGER_START = 7;
export const BADGE_RANK = 3;

/** The placed world, before anyone joins and before anything is spawned. */
export const AUTHORED_ENTITIES = 4;

export const SCRIPT_DIRECTOR = 'director';
export const SCRIPT_LEDGER = 'ledger';
export const SCRIPT_MARKER = 'marker';
export const SCRIPT_BADGE = 'badge';
export const SCRIPT_DRIFT = 'drift';

/** One widget per question: a press names the call, and the name is what the test reads back. */
export const W = {
    roster: 'roster',
    bounds: 'bounds',
    roll: 'roll',
    plant: 'plant',
    count: 'count',
    hop: 'hop',
    halt: 'halt',
    go: 'go',
    selfScript: 'self-script',
    gameScript: 'game-script',
    entityScript: 'entity-script',
    playerScript: 'player-script',
} as const;

/** Replicated readings, named so none of them collides with a member its host already owns. */
export const S = {
    crowd: 'crowd',
    census: 'census',
    extent: 'extent',
    rolls: 'rolls',
    reseeded: 'reseeded',
    advanced: 'advanced',
    yardX: 'yardX',
    yardY: 'yardY',
    byTag: 'byTag',
    inYard: 'inYard',
    rocksInYard: 'rocksInYard',
    nearTight: 'nearTight',
    nearWide: 'nearWide',
    seenHome: 'seenHome',
    seenNear: 'seenNear',
    liveNear: 'liveNear',
    seenIn: 'seenIn',
    sawTick: 'sawTick',
    selfFound: 'selfFound',
    ledgerWasThere: 'ledgerWasThere',
    ledgerIsThere: 'ledgerIsThere',
    markWasThere: 'markWasThere',
    markIsThere: 'markIsThere',
    badgeWasThere: 'badgeWasThere',
    badgeIsThere: 'badgeIsThere',
    /** The Ledger's, which no manifest attachment puts on the Game. */
    tally: 'tally',
    /** The Badge's, and player-hosted rather than game-hosted. */
    rank: 'rank',
} as const;

/** Not a readonly tuple: `pick` takes a mutable list. */
const PICKS = ['ash', 'birch', 'cedar'];

/** Tick-driven motion with no tween and no input behind it — what a paused world would stop. */
export class Drift extends ServerScript<Entity> {
    @onUpdate
    advance(ctx: Ctx): void {
        const at = this.host.position;
        this.host.setPosition(at.x + DRIFT_SPEED * ctx.dt, at.y);
    }
}

/** Attached at runtime, so its start running at all is what proves the attach did something. */
export class Ledger extends ServerScript<Game> {
    @serverState tally = 0;

    @onStart
    open(): void {
        this.tally = LEDGER_START;
    }
}

/** Its start tags the host, which is the one edge of an entity attach a client can observe. */
export class Marker extends ServerScript<Entity> {
    @onStart
    brand(): void {
        this.host.tag(TAG_MARKED);
    }
}

export class Badge extends ServerScript<Player> {
    @serverState rank = 0;

    @onStart
    award(): void {
        this.rank = BADGE_RANK;
    }
}

export class Director extends ServerScript<Game> {
    @serverState crowd = '';
    @serverState census = 0;
    @serverState extent = '';
    @serverState rolls = '';
    @serverState reseeded = false;
    @serverState advanced = false;
    @serverState yardX = 0;
    @serverState yardY = 0;
    @serverState byTag = 0;
    @serverState inYard = 0;
    @serverState rocksInYard = 0;
    @serverState nearTight = 0;
    @serverState nearWide = 0;
    @serverState seenHome = 0;
    @serverState seenNear = 0;
    @serverState liveNear = 0;
    @serverState seenIn = 0;
    /** Each starts on the answer its press must overturn, so an unwritten field cannot pass. */
    @serverState sawTick = true;
    @serverState selfFound = false;
    @serverState ledgerWasThere = true;
    @serverState markWasThere = true;
    @serverState badgeWasThere = true;
    @serverState ledgerIsThere = false;
    @serverState markIsThere = false;
    @serverState badgeIsThere = false;

    /** No `game` here: a roster handler carries no ambient runtime, so the const would throw. */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(AVATAR_AT.x, AVATAR_AT.y);
    }

    @onPress(W.roster)
    doRoster(): void {
        this.crowd = game.players
            .map((player) => `${player.index}:${player.name}`)
            .toSorted()
            .join(',');
        this.census = game.entities.length;
    }

    @onPress(W.bounds)
    doBounds(): void {
        const b = game.bounds;
        this.extent = `${b.left},${b.right},${b.top},${b.bottom}`;
    }

    /** Three draws around one reseed: the sequence must repeat after it and move on without it. */
    @onPress(W.roll)
    doRoll(): void {
        game.random.seed(SEED);
        const first = this.#draw();
        const next = this.#draw();
        game.random.seed(SEED);
        const again = this.#draw();
        this.rolls = first;
        this.reseeded = again === first;
        this.advanced = next !== first;
    }

    /** Drawn inside the region and spawned at, so `pointIn` and `find({ in })` check each other. */
    @onPress(W.plant)
    doPlant(): void {
        const at = game.random.pointIn(REGION_YARD);
        game.spawn(TEMPLATE_PROBE, at.x, at.y);
        this.yardX = at.x;
        this.yardY = at.y;
    }

    @onPress(W.count)
    doCount(): void {
        this.census = game.entities.length;
        this.byTag = game.find({ tag: TAG_ROCK }).length;
        this.inYard = game.find({ in: REGION_YARD }).length;
        this.rocksInYard = game.find({ tag: TAG_ROCK, in: REGION_YARD }).length;
        const rock = this.#outerRock();
        if (!rock) return;
        this.nearTight = game.find({ near: { of: rock, within: NEAR_TIGHT } }).length;
        this.nearWide = game.find({ near: { of: rock, within: NEAR_WIDE } }).length;
    }

    /**
     * One hop, read four ways, inside one handler.
     *
     * The lag ring captures at the END of a tick, so a press on the following tick would find the
     * hop already in the latest capture and every reading here would agree with every other.
     */
    @onPress(W.hop)
    doHop(ctx: Ctx): void {
        const sentinel = this.#sentinel();
        if (!sentinel) return;
        const home = { x: SENTINEL_AT.x, y: SENTINEL_AT.y, z: 0 };
        const yard = { x: SENTINEL_TO.x, y: SENTINEL_TO.y, z: 0 };
        sentinel.setPosition(SENTINEL_TO.x, SENTINEL_TO.y);
        this.seenHome = this.#sentinelsNear(home, true);
        this.seenNear = this.#sentinelsNear(yard, true);
        this.liveNear = this.#sentinelsNear(yard, false);
        // Only the `near` branch consults `asSeen`, so this one filters the live position.
        this.seenIn = game.find({ tag: TAG_SENTINEL, in: REGION_YARD, asSeen: true }).length;
        // A press carries no view tick, which is the handler `asSeen` is specified to refuse.
        this.sawTick = ctx.viewTick !== undefined;
    }

    @onPress(W.halt)
    doHalt(): void {
        game.pause();
    }

    @onPress(W.go)
    doGo(): void {
        game.resume();
    }

    @onPress(W.selfScript)
    doSelfScript(): void {
        this.selfFound = game.getScript(Director) === this;
    }

    /** Unguarded, unlike its two siblings: what a second attach does is itself pinned here. */
    @onPress(W.gameScript)
    doGameScript(): void {
        this.ledgerWasThere = game.getScript(Ledger) !== null;
        game.addScript(Ledger);
        this.ledgerIsThere = game.getScript(Ledger) !== null;
    }

    @onPress(W.entityScript)
    doEntityScript(): void {
        const sentinel = this.#sentinel();
        if (!sentinel) return;
        this.markWasThere = sentinel.getScript(Marker) !== null;
        if (!this.markWasThere) sentinel.addScript(Marker);
        this.markIsThere = sentinel.getScript(Marker) !== null;
    }

    @onPress(W.playerScript)
    doPlayerScript(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.badgeWasThere = player.getScript(Badge) !== null;
        if (!this.badgeWasThere) player.addScript(Badge);
        this.badgeIsThere = player.getScript(Badge) !== null;
    }

    #draw(): string {
        const r = game.random;
        return `${r.between(0, 1000)}|${r.pick(PICKS)}|${r.chance(0.5)}`;
    }

    #sentinelsNear(at: Vec3, asSeen: boolean): number {
        const near = { of: at, within: NEAR_TIGHT };
        return game.find({ tag: TAG_SENTINEL, near, asSeen }).length;
    }

    #sentinel(): Entity | null {
        return game.find({ tag: TAG_SENTINEL })[0] ?? null;
    }

    #outerRock(): Entity | null {
        return game.find({ tag: TAG_OUTER })[0] ?? null;
    }
}

export const GAME_WORLD: World = defineWorld({
    id: 'game',
    assets: [DISC_ASSET],
    bounds: GAME_BOUNDS,
    regions: [{ name: REGION_YARD, bounds: YARD }],
    scripts: [
        {
            id: SCRIPT_DIRECTOR,
            export: 'Director',
            path: 'src/worlds/game.ts',
            location: 'server',
            host: 'game',
            ctor: Director,
        },
        {
            id: SCRIPT_LEDGER,
            export: 'Ledger',
            path: 'src/worlds/game.ts',
            location: 'server',
            host: 'game',
            ctor: Ledger,
        },
        {
            id: SCRIPT_MARKER,
            export: 'Marker',
            path: 'src/worlds/game.ts',
            location: 'server',
            host: 'entity',
            ctor: Marker,
        },
        {
            id: SCRIPT_BADGE,
            export: 'Badge',
            path: 'src/worlds/game.ts',
            location: 'server',
            host: 'player',
            ctor: Badge,
        },
        {
            id: SCRIPT_DRIFT,
            export: 'Drift',
            path: 'src/worlds/game.ts',
            location: 'server',
            host: 'entity',
            ctor: Drift,
        },
    ],
    templates: [
        sprite(TEMPLATE_AVATAR),
        sprite(TEMPLATE_ROCK),
        sprite(TEMPLATE_PROBE),
        sprite(TEMPLATE_SENTINEL),
        sprite(TEMPLATE_DRIFTER, [attach(SCRIPT_DRIFT)]),
    ],
    entities: [
        {
            id: 'rock-in',
            template: templateId(TEMPLATE_ROCK),
            parent: null,
            transform: { x: ROCK_IN.x, y: ROCK_IN.y },
            tags: [TAG_ROCK],
            scripts: [],
        },
        {
            id: 'rock-out',
            template: templateId(TEMPLATE_ROCK),
            parent: null,
            transform: { x: ROCK_OUT.x, y: ROCK_OUT.y },
            tags: [TAG_ROCK, TAG_OUTER],
            scripts: [],
        },
        {
            id: 'sentinel',
            template: templateId(TEMPLATE_SENTINEL),
            parent: null,
            transform: { x: SENTINEL_AT.x, y: SENTINEL_AT.y },
            tags: [TAG_SENTINEL],
            scripts: [],
        },
        {
            id: 'drifter',
            template: templateId(TEMPLATE_DRIFTER),
            parent: null,
            transform: { x: DRIFT_AT.x, y: DRIFT_AT.y },
            tags: [],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_DIRECTOR)],
});

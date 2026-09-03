// A world whose whole game is the handler table: every lifecycle and event decorator, on the host
// the engine actually dispatches that kind at.
//
// Which host is the load-bearing part. An action edge reaches the player and their avatar, a pointer
// edge reaches the entity it landed on, a region crossing reaches the entity that crossed — so a
// suite that hung all of them on the Game would prove only that the decorators exist. Each handler
// here records that it fired into a `@serverState` field, so every claim is made against a CLIENT.

import type { Collider, Ctx, Entity, Game, HUDScreen, Player } from '@platform/engine';
import {
    ClientScript,
    ServerScript,
    game,
    onClick,
    onCollide,
    onEnd,
    onEnter,
    onEvent,
    onEventHold,
    onEventRelease,
    onExit,
    onHoverEnter,
    onHoverExit,
    onPlayerJoin,
    onPress,
    onRequest,
    onStart,
    onUpdate,
    request,
    serverState,
    sleep,
} from '@platform/engine';
import { templateId } from '@platform/project';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const TEMPLATE_BEACON = 'beacon';
export const TAG_BEACON = 'beacon';

export const SCRIPT_DIRECTOR = 'director';
export const SCRIPT_BODY = 'body';
export const SCRIPT_BEACON = 'beacon';
export const SCRIPT_SEAT = 'seat';
export const SCRIPT_KIOSK = 'kiosk';

export const SCREEN_KIOSK = 'kiosk';
export const WIDGET_ASK = 'ask';
export const REQUEST_GRANT = 'grant';
export const GRANT_AMOUNT = 7;

export const ACTION_PULSE = 'pulse';
export const ACTION_GATE = 'gate';
export const CODE_PULSE = 'KeyP';
export const CODE_GATE = 'KeyG';

/** Long enough that several taps land inside one invocation, which is what the three modes differ on. */
export const GATE_SECONDS = 1;

export const REGION_PIT = 'pit';
export const PIT_BOUNDS = { left: 80, right: 200, top: 160, bottom: 60 };

export const BODY_HALF = 12;
/** Where a joining avatar stands: inside no region, and clear of the beacon by more than both halves. */
export const HOME_AT = { x: 0, y: -120 };
export const PIT_AT = { x: 140, y: 110 };
/** Near enough the middle that the pick resolves against drawn art at any sane camera. */
export const BEACON_AT = { x: -80, y: 40 };

/** One widget per thing a test needs the authority to do to the pressing player's avatar. */
export const W = {
    mark: 'mark',
    toPit: 'to-pit',
    toHome: 'to-home',
    toBeacon: 'to-beacon',
    relay: 'relay',
} as const;

/** Game-hosted readings — every peer is told these, so any tab may be asked. */
export const S = {
    starts: 'starts',
    equips: 'equips',
    ticks: 'ticks',
    clicks: 'clicks',
    hoverIns: 'hoverIns',
    hoverOuts: 'hoverOuts',
    bumps: 'bumps',
    entries: 'entries',
    exits: 'exits',
    grants: 'grants',
    asker: 'asker',
    ends: 'ends',
    presser: 'presser',
} as const;

/** Player-hosted readings — an action edge is dispatched at the player, so its tallies live there. */
export const P = {
    presses: 'presses',
    releases: 'releases',
    holds: 'holds',
    ignoreIn: 'ignoreIn',
    ignoreOut: 'ignoreOut',
    restartIn: 'restartIn',
    restartOut: 'restartOut',
    manyIn: 'manyIn',
    manyOut: 'manyOut',
} as const;

/** Nothing in the engine or the manifest writes a collider, so a body without this touches nothing. */
function bodyBox(): Collider {
    return {
        enabled: true,
        isTrigger: true,
        bounds: { left: -BODY_HALF, right: BODY_HALF, top: BODY_HALF, bottom: -BODY_HALF },
    };
}

export class Director extends ServerScript<Game> {
    @serverState starts = 0;
    @serverState equips = 0;
    @serverState ticks = 0;
    @serverState clicks = 0;
    @serverState hoverIns = 0;
    @serverState hoverOuts = 0;
    @serverState bumps = 0;
    @serverState entries = 0;
    @serverState exits = 0;
    @serverState grants = 0;
    /** Who the authority believes asked, taken from the connection rather than from the frame. */
    @serverState asker = '';
    @serverState ends = 0;
    @serverState presser = '';

    /** Counted rather than set to true, so a second joiner re-running it would be visible. */
    @onStart
    begin(): void {
        this.starts = this.starts + 1;
    }

    @onUpdate
    count(): void {
        this.ticks = this.ticks + 1;
    }

    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Seat);
        player.spawn();
        player.teleportTo(HOME_AT.x, HOME_AT.y);
    }

    @onPress(W.mark)
    mark(ctx: Ctx): void {
        this.presser = ctx.player?.id ?? '';
    }

    @onPress(W.toPit)
    toPit(ctx: Ctx): void {
        ctx.player?.teleportTo(PIT_AT.x, PIT_AT.y);
    }

    @onPress(W.toHome)
    toHome(ctx: Ctx): void {
        ctx.player?.teleportTo(HOME_AT.x, HOME_AT.y);
    }

    @onPress(W.toBeacon)
    toBeacon(ctx: Ctx): void {
        ctx.player?.teleportTo(BEACON_AT.x, BEACON_AT.y);
    }

    /**
     * Raises the same ask from inside the authority, where the sink is already local.
     *
     * The same handler with no wire beneath it, so a suite that fails on the `Kiosk` route and
     * passes here has localised the fault to the channel rather than to the handler.
     */
    @onPress(W.relay)
    relay(): void {
        request(REQUEST_GRANT, { amount: GRANT_AMOUNT });
    }

    /** The only untrusted `ctx.data` in the API, which is why the amount is read defensively. */
    @onRequest(REQUEST_GRANT)
    grant(ctx: Ctx): void {
        const amount = ctx.data.amount;
        this.grants = this.grants + (typeof amount === 'number' ? amount : 0);
        this.asker = ctx.player?.id ?? '';
    }

    noteEquip(): void {
        this.equips = this.equips + 1;
    }

    noteClick(): void {
        this.clicks = this.clicks + 1;
    }

    noteHoverIn(): void {
        this.hoverIns = this.hoverIns + 1;
    }

    noteHoverOut(): void {
        this.hoverOuts = this.hoverOuts + 1;
    }

    noteBump(): void {
        this.bumps = this.bumps + 1;
    }

    noteEnter(): void {
        this.entries = this.entries + 1;
    }

    noteExit(): void {
        this.exits = this.exits + 1;
    }

    noteEnd(): void {
        this.ends = this.ends + 1;
    }
}

/** On every avatar, from the template: the entity half of what an input edge and a crossing reach. */
export class Body extends ServerScript<Entity> {
    @onStart
    equip(): void {
        this.host.collider = bodyBox();
        game.getScript(Director)?.noteEquip();
    }

    @onCollide(TAG_BEACON)
    bump(): void {
        game.getScript(Director)?.noteBump();
    }

    @onEnter(REGION_PIT)
    fell(): void {
        game.getScript(Director)?.noteEnter();
    }

    @onExit(REGION_PIT)
    climbed(): void {
        game.getScript(Director)?.noteExit();
    }
}

/** The one thing in this world a pointer can land on, and the one thing an avatar can walk into. */
export class Beacon extends ServerScript<Entity> {
    @onStart
    equip(): void {
        this.host.collider = bodyBox();
    }

    @onClick
    struck(): void {
        game.getScript(Director)?.noteClick();
    }

    @onHoverEnter
    lit(): void {
        game.getScript(Director)?.noteHoverIn();
    }

    @onHoverExit
    dimmed(): void {
        game.getScript(Director)?.noteHoverOut();
    }
}

/**
 * Attached at the join, because the input pass dispatches an action edge at the player's own host.
 *
 * A Game-hosted `@onEvent` is never reached by a key at all, which is why none of these live on
 * `Director` — and being player-hosted also scopes every tally below to the tab that earned it.
 */
export class Seat extends ServerScript<Player> {
    @serverState presses = 0;
    @serverState releases = 0;
    @serverState holds = 0;
    @serverState ignoreIn = 0;
    @serverState ignoreOut = 0;
    @serverState restartIn = 0;
    @serverState restartOut = 0;
    @serverState manyIn = 0;
    @serverState manyOut = 0;

    @onEvent(ACTION_PULSE)
    down(): void {
        this.presses = this.presses + 1;
    }

    @onEventRelease(ACTION_PULSE)
    up(): void {
        this.releases = this.releases + 1;
    }

    @onEventHold(ACTION_PULSE)
    still(): void {
        this.holds = this.holds + 1;
    }

    /** Each mode counts entries and completions apart, since that is the whole difference between them. */
    @onEvent(ACTION_GATE, { concurrency: 'ignore' })
    async once(): Promise<void> {
        this.ignoreIn = this.ignoreIn + 1;
        await sleep(GATE_SECONDS);
        this.ignoreOut = this.ignoreOut + 1;
    }

    @onEvent(ACTION_GATE, { concurrency: 'restart' })
    async again(): Promise<void> {
        this.restartIn = this.restartIn + 1;
        await sleep(GATE_SECONDS);
        this.restartOut = this.restartOut + 1;
    }

    @onEvent(ACTION_GATE, { concurrency: 'concurrent' })
    async many(): Promise<void> {
        this.manyIn = this.manyIn + 1;
        await sleep(GATE_SECONDS);
        this.manyOut = this.manyOut + 1;
    }

    /** The roster still holds this player here, so the Game can be told before the seat is cleared. */
    @onEnd
    stand(): void {
        game.getScript(Director)?.noteEnd();
    }
}

/**
 * The only client-located script here, and the only way to raise a `request()` from a browser.
 *
 * `request` resolves the ambient runtime's sink, and a mirror's sends a request frame — so this ask
 * is answered on the authority rather than on the machine that made it.
 */
export class Kiosk extends ClientScript<HUDScreen> {
    @onPress(WIDGET_ASK)
    beg(): void {
        request(REQUEST_GRANT, { amount: GRANT_AMOUNT });
    }
}

export const EVENTS_WORLD: World = defineWorld({
    id: 'events',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_DIRECTOR,
            export: 'Director',
            path: 'src/worlds/events.ts',
            location: 'server',
            host: 'game',
            ctor: Director,
        },
        {
            id: SCRIPT_BODY,
            export: 'Body',
            path: 'src/worlds/events.ts',
            location: 'server',
            host: 'entity',
            ctor: Body,
        },
        {
            id: SCRIPT_BEACON,
            export: 'Beacon',
            path: 'src/worlds/events.ts',
            location: 'server',
            host: 'entity',
            ctor: Beacon,
        },
        // Named in no attachment list: a player is not a placed thing, so `Director` attaches it at
        // the join. Declaring it is what keeps the manifest the whole inventory.
        {
            id: SCRIPT_SEAT,
            export: 'Seat',
            path: 'src/worlds/events.ts',
            location: 'server',
            host: 'player',
            ctor: Seat,
        },
        {
            id: SCRIPT_KIOSK,
            export: 'Kiosk',
            path: 'src/worlds/events.ts',
            location: 'client',
            host: 'screen',
            ctor: Kiosk,
        },
    ],
    templates: [
        sprite(TEMPLATE_AVATAR, [attach(SCRIPT_BODY)]),
        sprite(TEMPLATE_BEACON, [attach(SCRIPT_BEACON)], 0x8fd694),
    ],
    entities: [
        {
            id: 'the-beacon',
            template: templateId(TEMPLATE_BEACON),
            parent: null,
            transform: { x: BEACON_AT.x, y: BEACON_AT.y },
            tags: [TAG_BEACON],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_DIRECTOR)],
    regions: [{ name: REGION_PIT, bounds: PIT_BOUNDS }],
    bindings: [
        { kind: 'button', code: CODE_PULSE, action: ACTION_PULSE },
        { kind: 'button', code: CODE_GATE, action: ACTION_GATE },
    ],
    screens: [{ name: SCREEN_KIOSK, script: Kiosk as never }],
});

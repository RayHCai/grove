// A world whose whole game is the `Player` facade: the roster verbs, the two input surfaces a
// player carries, and the per-player store behind them.
//
// Nobody spawns at the join, because a body here is something the game HANDS OUT — which is what
// leaves `spawn`, `spectate` and `respawn` each reachable on its own. Every verb is reached by
// pressing a widget, so each call arrives on a real interaction frame with an engine-supplied
// `ctx.player`, and every reading is `@serverState` rather than a return value, so a test asserts
// on what a CLIENT was told rather than on the authority that made the call.

import type { Ctx, Entity, Game, InputBindings, Player } from '@platform/engine';
import { ServerScript, onEvent, onPlayerJoin, onPress, serverState } from '@platform/engine';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { StageBinding, World } from '../world.js';

export const SCRIPT_WARDEN = 'warden';
export const SCRIPT_SEAT = 'seat';

/** Where the roster's own default spawn puts a body, so an expected position is arithmetic-free. */
export const SPAWN_AT = { x: 0, y: 0 };
export const TELEPORT_AT = { x: -84, y: 36 };

export const ACTION_STEP = 'step';
export const ACTION_AIM = 'aim';

/** The one code this world binds. The other three name keys the client's table never mentions. */
export const CODE_STEP = 'KeyW';
export const CODE_STRANGE = 'KeyQ';
export const CODE_SPARE = 'KeyZ';
export const CODE_AIM = 'KeyE';

export const STORAGE_KEY = 'badge';
/** What a rename writes, so a test can tell the authority's roster from the one a tab holds. */
export const RENAMED = 'ada-again';

/** One widget per verb: a press names the call, and the name is what the test reads back. */
export const W = {
    look: 'look',
    spawn: 'spawn',
    spectate: 'spectate',
    respawn: 'respawn',
    teleport: 'teleport',
    disown: 'disown',
    reclaim: 'reclaim',
    identify: 'identify',
    rename: 'rename',
    remember: 'remember',
    recall: 'recall',
    forget: 'forget',
    readCursor: 'read-cursor',
    hideCursor: 'hide-cursor',
    bind: 'bind',
    clearOne: 'clear-one',
    clearAll: 'clear-all',
    context: 'context',
} as const;

/** Game-hosted readings, named so none of them collides with a member `Game` already owns. */
export const S = {
    bodied: 'bodied',
    bodiless: 'bodiless',
    seat: 'seat',
    who: 'who',
    stored: 'stored',
    pointer: 'pointer',
    shown: 'shown',
    keys: 'keys',
    copies: 'copies',
} as const;

/** The one Player-hosted reading, which reaches its own player's tab and no other. */
export const STATE_STEPS = 'steps';

export const BINDINGS: StageBinding[] = [{ kind: 'button', code: CODE_STEP, action: ACTION_STEP }];

/** The one script a player carries, and the only place this world hears about a key. */
export class Seat extends ServerScript<Player> {
    @serverState steps = 0;

    @onEvent(ACTION_STEP)
    step(): void {
        this.steps = this.steps + 1;
    }
}

export class Warden extends ServerScript<Game> {
    @serverState bodied = false;
    /** Whether reading `avatar` threw, which is the difference between it and `hasAvatar`. */
    @serverState bodiless = false;
    @serverState seat = -1;
    @serverState who = '';
    @serverState stored = '';
    /** The whole cursor as text: world point, screen point, what it is over, whether it is down. */
    @serverState pointer = '';
    @serverState shown = true;
    /** Both actions' bindings, as the authority's own table answers for them. */
    @serverState keys = '';
    @serverState copies = false;

    /** The body a `setAvatar(null)` parted from its player, which nothing else in this world holds. */
    #loose: Entity | null = null;

    /** No spawn: a body is handed out by a press, so each roster verb is reachable on its own. */
    @onPlayerJoin
    join(ctx: Ctx): void {
        ctx.player?.addScript(Seat);
    }

    /** Every reading of the body at once, for a test that wants the picture before it changes it. */
    @onPress(W.look)
    doLook(ctx: Ctx): void {
        const player = ctx.player;
        if (player) this.#readBody(player);
    }

    @onPress(W.spawn)
    doSpawn(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        this.#readBody(player);
    }

    @onPress(W.spectate)
    doSpectate(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spectate();
        this.#readBody(player);
    }

    @onPress(W.respawn)
    doRespawn(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.respawn();
        this.#readBody(player);
    }

    @onPress(W.teleport)
    doTeleport(ctx: Ctx): void {
        ctx.player?.teleportTo(TELEPORT_AT.x, TELEPORT_AT.y);
    }

    /** `setAvatar` is the roster's own setter, reachable from a script because nothing hides it. */
    @onPress(W.disown)
    doDisown(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.#loose = player.hasAvatar ? player.avatar : null;
        player.setAvatar(null);
        this.#readBody(player);
    }

    @onPress(W.reclaim)
    doReclaim(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.setAvatar(this.#loose);
        this.#loose = null;
        this.#readBody(player);
    }

    @onPress(W.identify)
    doIdentify(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        this.seat = player.index;
        this.who = player.name;
    }

    @onPress(W.rename)
    doRename(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.name = RENAMED;
        this.who = player.name;
    }

    /** Their own name, so a second player writing the same key is what proves the scope. */
    @onPress(W.remember)
    async doRemember(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (!player) return;
        await player.storage.set(STORAGE_KEY, player.name);
        this.stored = await this.#badge(player);
    }

    @onPress(W.recall)
    async doRecall(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (!player) return;
        this.stored = await this.#badge(player);
    }

    @onPress(W.forget)
    async doForget(ctx: Ctx): Promise<void> {
        const player = ctx.player;
        if (!player) return;
        await player.storage.delete(STORAGE_KEY);
        this.stored = await this.#badge(player);
    }

    @onPress(W.readCursor)
    doReadCursor(ctx: Ctx): void {
        const cursor = ctx.player?.cursor;
        if (!cursor) return;
        const at = cursor.position;
        const on = cursor.screenPosition;
        this.pointer = [
            `${at.x},${at.y},${at.z}`,
            `${on.x},${on.y},${on.z}`,
            cursor.over === null ? 'nothing' : 'something',
            cursor.isDown,
        ].join('|');
    }

    /** The read-back is written last, so any of the three calls above throwing would show here. */
    @onPress(W.hideCursor)
    doHideCursor(ctx: Ctx): void {
        const cursor = ctx.player?.cursor;
        if (!cursor) return;
        cursor.setIcon('crosshair');
        cursor.lock();
        cursor.unlock();
        cursor.visible = false;
        this.shown = cursor.visible;
    }

    @onPress(W.bind)
    doBind(ctx: Ctx): void {
        const input = ctx.player?.input;
        if (!input) return;
        input.rebind(ACTION_STEP, [CODE_STRANGE]);
        input.addBinding(ACTION_STEP, CODE_SPARE);
        input.rebind(ACTION_AIM, [CODE_AIM]);
        // The list handed back is a copy, so writing to it must bind nothing.
        input.getBindings(ACTION_STEP).push(CODE_STEP);
        this.copies = !input.getBindings(ACTION_STEP).includes(CODE_STEP);
        this.#readKeys(input);
    }

    @onPress(W.clearOne)
    doClearOne(ctx: Ctx): void {
        const input = ctx.player?.input;
        if (!input) return;
        input.resetBindings(ACTION_STEP);
        this.#readKeys(input);
    }

    @onPress(W.clearAll)
    doClearAll(ctx: Ctx): void {
        const input = ctx.player?.input;
        if (!input) return;
        input.resetBindings();
        this.#readKeys(input);
    }

    @onPress(W.context)
    doContext(ctx: Ctx): void {
        const input = ctx.player?.input;
        if (!input) return;
        input.setContext('menu');
        this.#readKeys(input);
    }

    #readBody(player: Player): void {
        this.bodied = player.hasAvatar;
        this.bodiless = !this.#reachable(player);
    }

    /** `avatar` throws where `hasAvatar` answers false, so the question has to be asked in a try. */
    #reachable(player: Player): boolean {
        try {
            return player.avatar.alive;
        } catch {
            return false;
        }
    }

    #readKeys(input: InputBindings): void {
        const step = input.getBindings(ACTION_STEP).join(' ');
        this.keys = `${step}/${input.getBindings(ACTION_AIM).join(' ')}`;
    }

    async #badge(player: Player): Promise<string> {
        const held = await player.storage.get(STORAGE_KEY);
        return typeof held === 'string' ? held : '';
    }
}

export const PLAYER_WORLD: World = defineWorld({
    id: 'player',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_WARDEN,
            export: 'Warden',
            path: 'src/worlds/player.ts',
            location: 'server',
            host: 'game',
            ctor: Warden,
        },
        // Player-hosted, and named in no attachment list: a player is not a tray row, so `Warden`
        // attaches it at the join. Declaring it is what makes the manifest the whole inventory.
        {
            id: SCRIPT_SEAT,
            export: 'Seat',
            path: 'src/worlds/player.ts',
            location: 'server',
            host: 'player',
            ctor: Seat,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR)],
    gameScripts: [attach(SCRIPT_WARDEN)],
    bindings: BINDINGS,
});

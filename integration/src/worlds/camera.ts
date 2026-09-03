// A world whose whole game is one player's camera, driven from the machine that draws it.
//
// A camera is client-local: core keeps its state off the transform store, no snapshot captures it
// and no write marks a channel. So the verbs are reached from a `ClientScript<Camera>` and the
// readings leave as HUD widgets rather than `@serverState`, which would be a claim about a wire
// this host never touches — what a test asserts on is the camera the tab hands its renderer.
//
// The lens is added by a `SyncedScript` on a placed console, because that is the only kind of
// script a manifest can put in a browser: a client-located class named by a template resolves to
// nothing in the server's registry, so no attach op is journaled and no tab is ever told of it.

import type { Bounds, Camera, Ctx, Game, Player } from '@platform/engine';
import {
    ClientScript,
    Entity,
    ServerScript,
    SyncedScript,
    game,
    hud,
    onPlayerJoin,
    onPress,
} from '@platform/engine';
import { templateId } from '@platform/project';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const TEMPLATE_CONSOLE = 'console';

export const SCRIPT_STAGE = 'stage';
export const SCRIPT_RIG = 'rig';
export const SCRIPT_LENS = 'lens';

/** Where a joining avatar is put, so a camera that follows it has a known place to be. */
export const AVATAR_AT = { x: 90, y: -40 };
/** Where the console stands — nowhere near the avatar, so a follow is told from a pan. */
export const CONSOLE_AT = { x: -140, y: 60 };

export const PAN_TO = { x: 55, y: 25 };
export const GLIDE_TO = { x: -70, y: 35 };
export const ZOOM_TO = 2;
/** Long enough that a camera actually on the tween engine would still be moving after a press. */
export const TWEEN_SECONDS = 0.5;
export const SHAKE_STRENGTH = 8;

/** A box `PAN_TO` sits far outside of, since nothing clamps a camera to the bounds it is given. */
export const FENCE: Bounds = { left: -10, right: 10, top: 10, bottom: -10 };

/** The half-extents core's `Camera.viewport` hardcodes, whatever stage or zoom it is standing in. */
export const VIEW_HALF = { w: 400, h: 300 };

/** One widget per verb: a press names the call, and the name is what the test reads back. */
export const W = {
    mount: 'mount',
    pan: 'pan',
    glideTo: 'glide-to',
    zoomTo: 'zoom-to',
    follow: 'follow',
    followSelf: 'follow-self',
    unfollow: 'unfollow',
    shake: 'shake',
    fence: 'fence',
    read: 'read',
} as const;

/** What the lens publishes. HUD widgets, because nothing on a camera host reaches a wire. */
export const WIDGET = {
    spot: 'spot',
    view: 'view',
    fence: 'fence-read',
    target: 'target',
    zoom: 'zoom',
    shakes: 'shakes',
} as const;

export const NONE = 'none';
export const TARGET_ENTITY = 'entity';
export const TARGET_PLAYER = 'player';

export class Stage extends ServerScript<Game> {
    @onPlayerJoin
    seat(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(AVATAR_AT.x, AVATAR_AT.y);
    }
}

/**
 * Every camera verb that holds state, on the host that owns it.
 *
 * Nothing here is replicated and nothing here is asked for by the authority: each handler runs on
 * the one client whose player pressed the widget, against that client's own copy of the camera.
 */
export class Lens extends ClientScript<Camera> {
    /** Shakes that answered with the camera itself — the only trace the call leaves anywhere. */
    #shakes = 0;

    @onPress(W.glideTo)
    glide(): void {
        void this.host.glideTo(GLIDE_TO.x, GLIDE_TO.y, TWEEN_SECONDS);
    }

    @onPress(W.zoomTo)
    closer(): void {
        void this.host.zoomTo(ZOOM_TO, TWEEN_SECONDS);
    }

    @onPress(W.follow)
    followAvatar(): void {
        const avatar = this.#avatar();
        if (avatar) this.host.follow(avatar);
    }

    @onPress(W.followSelf)
    followPlayer(): void {
        this.host.follow(this.host.player);
    }

    @onPress(W.unfollow)
    followNothing(): void {
        this.host.follow(null);
    }

    @onPress(W.shake)
    rattle(): void {
        if (this.host.shake(SHAKE_STRENGTH, TWEEN_SECONDS) === this.host) this.#shakes += 1;
        hud.number(WIDGET.shakes, this.#shakes);
    }

    @onPress(W.fence)
    pen(): void {
        this.host.bounds = FENCE;
    }

    @onPress(W.read)
    publish(): void {
        const camera = this.host;
        const at = camera.position;
        const view = camera.viewport;
        hud.text(WIDGET.spot, `${at.x}|${at.y}|${at.z}`);
        hud.text(WIDGET.view, `${view.left}|${view.right}|${view.top}|${view.bottom}`);
        hud.text(WIDGET.fence, describeBounds(camera.bounds));
        hud.text(WIDGET.target, describeTarget(camera.followTarget));
        hud.number(WIDGET.zoom, camera.zoom);
    }

    /** A mirror never fills `player.avatar`, so ownership is this end's only handle on it. */
    #avatar(): Entity | null {
        const mine = this.host.player.id;
        return game.entities.find((e) => e.owner?.id === mine) ?? null;
    }
}

/**
 * The one script both ends run, and the only way this game reaches a camera at all.
 *
 * `moveTo` is here rather than on the lens deliberately: a synced handler runs on the authority and
 * on the pressing client alike, which is what lets a test see the two copies drift apart.
 */
export class Rig extends SyncedScript<Entity> {
    @onPress(W.mount)
    mount(ctx: Ctx): void {
        ctx.player?.camera.addScript(Lens);
    }

    @onPress(W.pan)
    pan(ctx: Ctx): void {
        ctx.player?.camera.moveTo(PAN_TO.x, PAN_TO.y);
    }
}

/** A string is a region name, which core stores and reads back without resolving. */
function describeBounds(fence: Bounds | string | null): string {
    if (fence === null) return NONE;
    if (typeof fence === 'string') return fence;
    return `${fence.left}|${fence.right}|${fence.top}|${fence.bottom}`;
}

function describeTarget(target: Player | Entity | null): string {
    if (target === null) return NONE;
    return target instanceof Entity ? TARGET_ENTITY : TARGET_PLAYER;
}

export const CAMERA_WORLD: World = defineWorld({
    id: 'camera',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_STAGE,
            export: 'Stage',
            path: 'src/worlds/camera.ts',
            location: 'server',
            host: 'game',
            ctor: Stage,
        },
        {
            id: SCRIPT_RIG,
            export: 'Rig',
            path: 'src/worlds/camera.ts',
            location: 'synced',
            host: 'entity',
            ctor: Rig,
        },
        {
            id: SCRIPT_LENS,
            export: 'Lens',
            path: 'src/worlds/camera.ts',
            location: 'client',
            host: 'camera',
            ctor: Lens,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR), sprite(TEMPLATE_CONSOLE, [attach(SCRIPT_RIG)], 0x9fc7ea)],
    entities: [
        {
            id: 'the-console',
            template: templateId(TEMPLATE_CONSOLE),
            parent: null,
            transform: { x: CONSOLE_AT.x, y: CONSOLE_AT.y },
            tags: [],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_STAGE)],
    mirrorWidget: WIDGET.zoom,
});

// A world of props that move themselves, so the three motion helpers can be watched rather than
// called.
//
// Each helper is started from an `@onPress` on the Game host, because `oscillate` and `orbit` are a
// per-tick timer around a curve and a timer needs the ambient runtime an interaction frame supplies.
// Only the plain-object tween reports through `@serverState`: a property on a private object reaches
// no wire on its own, while a body's position is already replicated and is read off the mirror.

import type { Ctx, Entity, Game } from '@platform/engine';
import {
    ServerScript,
    game,
    onPlayerJoin,
    onPress,
    orbit,
    oscillate,
    serverState,
    tween,
} from '@platform/engine';
import type { EntityRecord } from '@platform/project';
import { templateId } from '@platform/project';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_DIRECTOR = 'motion-director';
export const TEMPLATE_PROP = 'prop';

/** One tag per prop, which is the only key `find` offers and the only one a snapshot carries. */
export const TAG_SWING_X = 'swing-x';
export const TAG_SWING_Y = 'swing-y';
export const TAG_HUB = 'hub';
export const TAG_MOON = 'moon';
export const TAG_DOT = 'dot';

export const AVATAR_AT = { x: 0, y: -150 };

export const SWING_X_AT = { x: 0, y: 100 };
export const SWING_Y_AT = { x: -200, y: 0 };
export const SWING_AMOUNT = 60;
/** A whole number of send intervals, so a sampled tick has a sampled twin one period later. */
export const SWING_SECONDS = 2;

export const HUB_AT = { x: 160, y: -40 };
export const ORBIT_RADIUS = 70;
/** Radians a second: a revolution is `2π / speed`, which makes this one two seconds long. */
export const ORBIT_SPEED = Math.PI;
export const HUB_SHIFT = 90;

export const DOT_AT = { x: -120, y: 120 };
export const DOT_FADE_TO = 0.25;
export const DOT_SLIDE_TO = 200;
/** What `shadow` still reads if the slide tween wrote nothing onto the facade at all. */
export const SHADOW_NONE = -1;

export const DIAL_FAR = 300;
export const TILT_FAR = 90;
export const DIAL_NEAR = -40;
export const DIAL_SLOW_SECONDS = 1;
export const TWEEN_SECONDS = 0.25;
export const RACE_TO = 100;
export const RACE_SECONDS = 0.5;

export const W = {
    swingX: 'swing-x',
    swingY: 'swing-y',
    orbit: 'orbit',
    shiftHub: 'shift-hub',
    dialFar: 'dial-far',
    dialNear: 'dial-near',
    race: 'race',
    readDial: 'read-dial',
    fadeDot: 'fade-dot',
    slideDot: 'slide-dot',
} as const;

/** Replicated readings, none of them a name `Game` already owns. */
export const S = {
    level: 'level',
    tilt: 'tilt',
    settled: 'settled',
    shadow: 'shadow',
} as const;

export class Director extends ServerScript<Game> {
    @serverState level = 0;
    @serverState tilt = 0;
    /** How many tween handlers reached the line after their await, cancelled or run to the end. */
    @serverState settled = 0;
    /** Where the entity-aimed slide below actually put its number. */
    @serverState shadow = SHADOW_NONE;

    /** Not an entity: the target `tween` reaches by plain property get and set. */
    readonly #dial = { level: 0, tilt: 0 };

    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(AVATAR_AT.x, AVATAR_AT.y);
    }

    @onPress(W.swingX)
    doSwingX(): void {
        const prop = this.#prop(TAG_SWING_X);
        if (prop) oscillate(prop, 'x', SWING_AMOUNT, SWING_SECONDS);
    }

    @onPress(W.swingY)
    doSwingY(): void {
        const prop = this.#prop(TAG_SWING_Y);
        if (prop) oscillate(prop, 'y', SWING_AMOUNT, SWING_SECONDS);
    }

    @onPress(W.orbit)
    doOrbit(): void {
        const moon = this.#prop(TAG_MOON);
        const hub = this.#prop(TAG_HUB);
        if (moon && hub) orbit(moon, hub, ORBIT_RADIUS, ORBIT_SPEED);
    }

    @onPress(W.shiftHub)
    doShiftHub(): void {
        this.#prop(TAG_HUB)?.moveBy(HUB_SHIFT, 0);
    }

    @onPress(W.dialFar)
    async doDialFar(): Promise<void> {
        await tween(this.#dial, { level: DIAL_FAR, tilt: TILT_FAR }, DIAL_SLOW_SECONDS);
        this.settled = this.settled + 1;
    }

    /** Names `level` alone, so `tilt` is there to show that a cancel is per property. */
    @onPress(W.dialNear)
    async doDialNear(): Promise<void> {
        await tween(this.#dial, { level: DIAL_NEAR }, TWEEN_SECONDS);
        this.settled = this.settled + 1;
    }

    /** Two props from the same start to the same target, differing only in the curve. */
    @onPress(W.race)
    doRace(): void {
        void tween(this.#dial, { level: RACE_TO }, RACE_SECONDS, 'easeOut');
        void tween(this.#dial, { tilt: RACE_TO }, RACE_SECONDS);
    }

    @onPress(W.readDial)
    doReadDial(): void {
        this.level = this.#dial.level;
        this.tilt = this.#dial.tilt;
    }

    @onPress(W.fadeDot)
    doFadeDot(): void {
        const dot = this.#prop(TAG_DOT);
        if (dot) void tween(dot, { opacity: DOT_FADE_TO }, TWEEN_SECONDS);
    }

    @onPress(W.slideDot)
    async doSlideDot(): Promise<void> {
        const dot = this.#prop(TAG_DOT);
        if (!dot) return;
        await tween(dot, { x: DOT_SLIDE_TO }, TWEEN_SECONDS);
        // Read off the facade as a bag rather than through a getter, since `x` is not one of the
        // accessors `Entity` declares and a plain assignment is all the helper performed.
        this.shadow = (dot as unknown as { x?: number }).x ?? SHADOW_NONE;
    }

    #prop(tag: string): Entity | null {
        return game.find({ tag })[0] ?? null;
    }
}

function placed(id: string, tag: string, at: { x: number; y: number }): EntityRecord {
    return {
        id,
        template: templateId(TEMPLATE_PROP),
        parent: null,
        transform: { x: at.x, y: at.y },
        tags: [tag],
        scripts: [],
    };
}

export const MOTION_WORLD: World = defineWorld({
    id: 'motion',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_DIRECTOR,
            export: 'Director',
            path: 'src/worlds/motion.ts',
            location: 'server',
            host: 'game',
            ctor: Director,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR), sprite(TEMPLATE_PROP, [], 0x8fd694)],
    entities: [
        placed('swinger-x', TAG_SWING_X, SWING_X_AT),
        placed('swinger-y', TAG_SWING_Y, SWING_Y_AT),
        placed('the-hub', TAG_HUB, HUB_AT),
        // Starts on the hub, so a ring is something the orbit had to put it on.
        placed('the-moon', TAG_MOON, HUB_AT),
        placed('the-dot', TAG_DOT, DOT_AT),
    ],
    gameScripts: [attach(SCRIPT_DIRECTOR)],
});

// A world whose whole game is one entity doing what the `Entity` API says it can do.
//
// Every verb is reached by pressing a widget, so each call arrives on a real interaction frame with
// an engine-supplied `ctx.player` — the same path a button in a real game takes. Nothing here calls
// into the runtime from the test side, because a call made outside a handler proves only that the
// method exists.
//
// The readings are `@serverState` on the Game rather than return values, so every assertion is made
// against what a CLIENT was told, one replication interval behind the call that caused it.

import type { Ctx, Entity, Game } from '@platform/engine';
import { ServerScript, game, onPlayerJoin, onPress, onStart, serverState } from '@platform/engine';
import { templateId } from '@platform/project';
import { DISC_ASSET, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const TEMPLATE_MARK = 'mark';
export const TAG_MARK = 'mark';
export const TAG_SAID = 'said';

/** Where the placed mark sits — a fixed point, so an expected distance is arithmetic, not a reading. */
export const MARK_AT = { x: 120, y: 0 };
/** Where a joining avatar is put, so every distance and bearing below is known before the run. */
export const AVATAR_AT = { x: 0, y: 0 };
export const AVATAR_HALF = 12;

export const SCRIPT_DIRECTOR = 'director';
export const SCRIPT_BODY = 'body';

/** One widget per verb: a press names the call, and the name is what the test reads back. */
export const W = {
    rotateBy: 'rotate-by',
    setRotation: 'set-rotation',
    setScale: 'set-scale',
    moveToward: 'move-toward',
    faceToward: 'face-toward',
    measure: 'measure',
    glideBy: 'glide-by',
    glideTo: 'glide-to',
    fadeOut: 'fade-out',
    fadeIn: 'fade-in',
    fadeTo: 'fade-to',
    growTo: 'grow-to',
    spin: 'spin',
    spinTo: 'spin-to',
    attach: 'attach',
    detach: 'detach',
    tag: 'tag',
    untag: 'untag',
    show: 'show',
    hide: 'hide',
    say: 'say',
    clearSay: 'clear-say',
    think: 'think',
    playClip: 'play-clip',
    stopAnimation: 'stop-animation',
    playEffect: 'play-effect',
    destroy: 'destroy',
    readAll: 'read-all',
} as const;

/** Replicated readings, named so none of them collides with a member `Game` already owns. */
export const S = {
    distance: 'distance',
    marks: 'marks',
    touching: 'touching',
    contact: 'contact',
    badged: 'badged',
    parented: 'parented',
    kids: 'kids',
    inert: 'inert',
    alive: 'alive',
    effects: 'effects',
} as const;

/** Seconds every tween below runs for, short enough that a test settles it in a few dozen ticks. */
export const TWEEN_SECONDS = 0.25;
export const MOVE_SPEED = 30;

/** A collider, so `getTouching` has something to answer with. */
export class Body extends ServerScript<Entity> {
    @onStart
    equip(): void {
        this.host.collider = {
            enabled: true,
            isTrigger: true,
            bounds: {
                left: -AVATAR_HALF,
                right: AVATAR_HALF,
                top: AVATAR_HALF,
                bottom: -AVATAR_HALF,
            },
        };
    }
}

export class Director extends ServerScript<Game> {
    @serverState distance = 0;
    /** The avatar's tags, joined — a list is not a replicated shape, and this is read as text. */
    @serverState marks = '';
    @serverState touching = 0;
    /** The same overlap and the same tag, read through the predicate rather than the list. */
    @serverState contact = false;
    @serverState badged = false;
    @serverState parented = false;
    @serverState kids = 0;
    /** How many times a verb that does nothing today was called and returned the entity anyway. */
    @serverState inert = 0;
    @serverState alive = true;
    @serverState effects = 0;

    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(AVATAR_AT.x, AVATAR_AT.y);
    }

    @onPress(W.rotateBy)
    doRotateBy(ctx: Ctx): void {
        this.#avatar(ctx)?.rotateBy(45);
    }

    @onPress(W.setRotation)
    doSetRotation(ctx: Ctx): void {
        this.#avatar(ctx)?.setRotation(90);
    }

    @onPress(W.setScale)
    doSetScale(ctx: Ctx): void {
        this.#avatar(ctx)?.setScale(2);
    }

    @onPress(W.moveToward)
    doMoveToward(ctx: Ctx): void {
        const mark = this.#mark();
        if (mark) this.#avatar(ctx)?.moveToward(mark, MOVE_SPEED);
    }

    @onPress(W.faceToward)
    doFaceToward(ctx: Ctx): void {
        const mark = this.#mark();
        if (mark) this.#avatar(ctx)?.faceToward(mark);
    }

    @onPress(W.measure)
    doMeasure(ctx: Ctx): void {
        const mark = this.#mark();
        const avatar = this.#avatar(ctx);
        if (mark && avatar) this.distance = avatar.distanceTo(mark);
    }

    @onPress(W.glideBy)
    doGlideBy(ctx: Ctx): void {
        void this.#avatar(ctx)?.glideBy(60, 40, TWEEN_SECONDS);
    }

    @onPress(W.glideTo)
    doGlideTo(ctx: Ctx): void {
        void this.#avatar(ctx)?.glideTo(-80, 50, TWEEN_SECONDS);
    }

    @onPress(W.fadeOut)
    doFadeOut(ctx: Ctx): void {
        void this.#avatar(ctx)?.fadeOut(TWEEN_SECONDS);
    }

    @onPress(W.fadeIn)
    doFadeIn(ctx: Ctx): void {
        void this.#avatar(ctx)?.fadeIn(TWEEN_SECONDS);
    }

    @onPress(W.fadeTo)
    doFadeTo(ctx: Ctx): void {
        void this.#avatar(ctx)?.fadeTo(0.5, TWEEN_SECONDS);
    }

    @onPress(W.growTo)
    doGrowTo(ctx: Ctx): void {
        void this.#avatar(ctx)?.growTo(3, TWEEN_SECONDS);
    }

    @onPress(W.spin)
    doSpin(ctx: Ctx): void {
        void this.#avatar(ctx)?.spin(180, TWEEN_SECONDS);
    }

    @onPress(W.spinTo)
    doSpinTo(ctx: Ctx): void {
        void this.#avatar(ctx)?.spinTo(270, TWEEN_SECONDS);
    }

    @onPress(W.attach)
    doAttach(ctx: Ctx): void {
        const mark = this.#mark();
        if (mark) this.#avatar(ctx)?.attachTo(mark);
        this.#readHierarchy(ctx);
    }

    @onPress(W.detach)
    doDetach(ctx: Ctx): void {
        this.#avatar(ctx)?.detach();
        this.#readHierarchy(ctx);
    }

    @onPress(W.tag)
    doTag(ctx: Ctx): void {
        this.#avatar(ctx)?.tag(TAG_MARK);
        this.#readTags(ctx);
    }

    @onPress(W.untag)
    doUntag(ctx: Ctx): void {
        this.#avatar(ctx)?.untag(TAG_MARK);
        this.#readTags(ctx);
    }

    @onPress(W.show)
    doShow(ctx: Ctx): void {
        this.#avatar(ctx)?.show();
    }

    @onPress(W.hide)
    doHide(ctx: Ctx): void {
        this.#avatar(ctx)?.hide();
    }

    @onPress(W.say)
    doSay(ctx: Ctx): void {
        this.#avatar(ctx)?.say(TAG_SAID);
        this.#readTags(ctx);
    }

    @onPress(W.clearSay)
    doClearSay(ctx: Ctx): void {
        this.#avatar(ctx)?.clearSay();
        this.#readTags(ctx);
    }

    /** `think` and `stopAnimation` hold no state today; what is pinned is that they chain. */
    @onPress(W.think)
    doThink(ctx: Ctx): void {
        const avatar = this.#avatar(ctx);
        if (avatar && avatar.think('hm') === avatar) this.inert = this.inert + 1;
    }

    @onPress(W.stopAnimation)
    doStopAnimation(ctx: Ctx): void {
        const avatar = this.#avatar(ctx);
        if (avatar && avatar.stopAnimation() === avatar) this.inert = this.inert + 1;
    }

    @onPress(W.playClip)
    doPlayClip(ctx: Ctx): void {
        void this.#avatar(ctx)?.play('walk');
        this.effects = this.effects + 1;
    }

    @onPress(W.playEffect)
    doPlayEffect(ctx: Ctx): void {
        this.#avatar(ctx)?.playEffect('puff');
        this.effects = this.effects + 1;
    }

    @onPress(W.destroy)
    doDestroy(ctx: Ctx): void {
        const avatar = this.#avatar(ctx);
        avatar?.destroy();
        this.alive = avatar?.alive ?? false;
    }

    /** Every reading at once, for a test that wants a settled picture rather than one field. */
    @onPress(W.readAll)
    doReadAll(ctx: Ctx): void {
        this.#readTags(ctx);
        this.#readHierarchy(ctx);
        const avatar = this.#avatar(ctx);
        this.touching = avatar?.getTouching().length ?? 0;
        // The predicate beside the list it is defined in terms of, so a test can catch the two
        // disagreeing rather than trusting that one is written from the other.
        this.contact = avatar?.isTouching() ?? false;
        this.alive = avatar?.alive ?? false;
    }

    #readTags(ctx: Ctx): void {
        const avatar = this.#avatar(ctx);
        this.marks = (avatar?.tags ?? []).toSorted().join(',');
        this.badged = avatar?.hasTag(TAG_MARK) ?? false;
    }

    #readHierarchy(ctx: Ctx): void {
        this.parented = this.#avatar(ctx)?.parent !== null;
        this.kids = this.#mark()?.children.length ?? 0;
    }

    /** The pressing player's own avatar; a press with no live avatar behind it does nothing. */
    #avatar(ctx: Ctx): Entity | null {
        const player = ctx.player;
        if (!player || !player.hasAvatar) return null;
        return player.avatar;
    }

    #mark(): Entity | null {
        // By tag rather than by template, which `find` does not query on — the placed mark is the
        // only thing in this world carrying it, and an avatar only gets it by pressing for it.
        return game.find({ tag: TAG_MARK }).find((e) => !e.owner) ?? null;
    }
}

export const ENTITY_WORLD: World = defineWorld({
    id: 'entity',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_DIRECTOR,
            export: 'Director',
            path: 'src/worlds/entity.ts',
            location: 'server',
            host: 'game',
            ctor: Director,
        },
        {
            id: SCRIPT_BODY,
            export: 'Body',
            path: 'src/worlds/entity.ts',
            location: 'server',
            host: 'entity',
            ctor: Body,
        },
    ],
    templates: [
        sprite(TEMPLATE_AVATAR, [attach(SCRIPT_BODY)]),
        sprite(TEMPLATE_MARK, [attach(SCRIPT_BODY)], 0x8fd694),
    ],
    entities: [
        {
            id: 'the-mark',
            template: templateId(TEMPLATE_MARK),
            parent: null,
            transform: { x: MARK_AT.x, y: MARK_AT.y },
            tags: [TAG_MARK],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_DIRECTOR)],
});

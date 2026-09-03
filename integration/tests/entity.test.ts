// The `Entity` API, driven through a game and read back off a client.
//
// Every case presses a widget and then settles: a press rides an interaction frame to the
// authority, the call runs inside a handler there, and the result reaches this tab one replication
// interval later. Asserting on the MIRROR rather than the server is the point — a method that moved
// an entity on the authority and never marked a channel would pass a unit test and fail here.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import type { Session, Tab } from './harness.js';
import {
    avatarOf,
    gameField,
    newSession,
    ofTemplate,
    runtimeOf,
    transformIn,
    parentIn,
} from './harness.js';
import {
    AVATAR_AT,
    ENTITY_WORLD,
    MARK_AT,
    S,
    TAG_MARK,
    TAG_SAID,
    TEMPLATE_MARK,
    TWEEN_SECONDS,
    W,
} from '../dist/worlds/entity.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
/** Ticks that outlast the tweens this world starts, whatever the send rate rounds them to. */
const TWEEN_TICKS = Math.ceil(TWEEN_SECONDS * 60) + SETTLE;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(ENTITY_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

/** Presses one widget and settles, which is the whole shape of every case below. */
async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

/** This tab's own avatar as its own mirror holds it. */
function mine(tab: Tab): EntityId {
    const id = avatarOf(tab);
    if (id === undefined) throw new Error('no avatar in the mirror');
    return id;
}

function drawn(tab: Tab): ReturnType<typeof transformIn> {
    return transformIn(runtimeOf(tab), mine(tab));
}

function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

describe("an entity's transform", () => {
    it('turns by a delta and to an absolute, and both reach the tab', async () => {
        const { session, tab } = await open();
        expect(drawn(tab).rotation).toBe(0);

        await press(session, tab, W.rotateBy);
        expect(drawn(tab).rotation).toBe(45);

        // Twice, because a delta that was quietly an assignment would still read 45 after one press.
        await press(session, tab, W.rotateBy);
        expect(drawn(tab).rotation).toBe(90);

        await press(session, tab, W.setRotation);
        expect(drawn(tab).rotation).toBe(90);
    });

    it('scales, and the mirror is told the new scale rather than inferring it', async () => {
        const { session, tab } = await open();
        expect(drawn(tab).scale).toBe(1);
        await press(session, tab, W.setScale);
        expect(drawn(tab).scale).toBe(2);
    });

    it('steps toward a target by at most the speed it was given', async () => {
        const { session, tab } = await open();
        expect(drawn(tab).x).toBeCloseTo(AVATAR_AT.x, 5);

        await press(session, tab, W.moveToward);
        // The mark is due east, so the whole step lands on x and none of it on y.
        expect(drawn(tab).x).toBeCloseTo(30, 5);
        expect(drawn(tab).y).toBeCloseTo(0, 5);
    });

    it('never overshoots the target it is stepping toward', async () => {
        const { session, tab } = await open();
        // Four steps of 30 would reach 120 exactly; a fifth must not carry it past the mark.
        for (let i = 0; i < 6; i++) await press(session, tab, W.moveToward);
        expect(drawn(tab).x).toBeCloseTo(MARK_AT.x, 5);
    });

    it('faces a target by bearing, not by turning some fixed amount', async () => {
        const { session, tab } = await open();
        // Due east of the avatar, so the bearing is zero — and a `faceToward` that added instead of
        // assigning would leave a non-zero rotation here.
        await press(session, tab, W.faceToward);
        expect(drawn(tab).rotation).toBeCloseTo(0, 5);
    });

    it('measures the distance to a target, and the number reaches the tab', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.measure);
        expect(reading<number>(tab, S.distance)).toBeCloseTo(MARK_AT.x - AVATAR_AT.x, 5);
    });

    it('shows and hides by opacity, which is a drawn field like any other', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.hide);
        expect(drawn(tab).opacity).toBe(0);
        await press(session, tab, W.show);
        expect(drawn(tab).opacity).toBe(1);
    });
});

describe("an entity's tweens", () => {
    it('glides by a delta and arrives, over ticks rather than at once', async () => {
        const { session, tab } = await open();
        session.press(tab, W.glideBy);
        await session.step(2);
        const early = drawn(tab);
        // Started but not arrived: a glide that snapped would already be at the target here.
        expect(early.x).toBeLessThan(60);

        await session.step(TWEEN_TICKS);
        const late = drawn(tab);
        expect(late.x).toBeCloseTo(60, 3);
        expect(late.y).toBeCloseTo(40, 3);
    });

    it('glides to an absolute point', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.glideTo, TWEEN_TICKS);
        const at = drawn(tab);
        expect(at.x).toBeCloseTo(-80, 3);
        expect(at.y).toBeCloseTo(50, 3);
    });

    it('fades out, in, and to a value in between', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.fadeOut, TWEEN_TICKS);
        expect(drawn(tab).opacity).toBeCloseTo(0, 3);

        await press(session, tab, W.fadeIn, TWEEN_TICKS);
        expect(drawn(tab).opacity).toBeCloseTo(1, 3);

        await press(session, tab, W.fadeTo, TWEEN_TICKS);
        expect(drawn(tab).opacity).toBeCloseTo(0.5, 3);
    });

    it('grows to a scale', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.growTo, TWEEN_TICKS);
        expect(drawn(tab).scale).toBeCloseTo(3, 3);
    });

    it('spins by a delta and to an absolute', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spin, TWEEN_TICKS);
        expect(drawn(tab).rotation).toBeCloseTo(180, 3);

        // From 180, so an absolute spin lands on 270 and a second delta would have reached 360.
        await press(session, tab, W.spinTo, TWEEN_TICKS);
        expect(drawn(tab).rotation).toBeCloseTo(270, 3);
    });
});

describe("an entity's hierarchy", () => {
    it('attaches beneath another entity, and the reparent reaches the tab', async () => {
        const { session, tab } = await open();
        const rt = runtimeOf(tab);
        const mark = ofTemplate(rt, TEMPLATE_MARK)[0];
        expect(mark).toBeDefined();
        expect(parentIn(rt, mine(tab))).toBeUndefined();

        await press(session, tab, W.attach);
        expect(reading<boolean>(tab, S.parented)).toBe(true);
        expect(reading<number>(tab, S.kids)).toBe(1);
        // Read from the MIRROR's own table: the authority marking a reparent is not the same claim
        // as a client having applied one.
        expect(parentIn(runtimeOf(tab), mine(tab))).toBe(mark);
    });

    it('detaches back to the world root', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.attach);
        await press(session, tab, W.detach);
        expect(reading<boolean>(tab, S.parented)).toBe(false);
        expect(reading<number>(tab, S.kids)).toBe(0);
        expect(parentIn(runtimeOf(tab), mine(tab))).toBeUndefined();
    });
});

describe("an entity's tags", () => {
    it('tags and untags, and each edge reaches the tab', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.tag);
        expect(reading<string>(tab, S.marks)).toBe(TAG_MARK);
        expect(runtimeOf(tab).tags.has(mine(tab), TAG_MARK)).toBe(true);

        await press(session, tab, W.untag);
        expect(reading<string>(tab, S.marks)).toBe('');
        expect(runtimeOf(tab).tags.has(mine(tab), TAG_MARK)).toBe(false);
    });

    it('answers hasTag with what the tag list holds, both before and after an edge', async () => {
        const { session, tab } = await open();
        expect(reading<boolean>(tab, S.badged)).toBe(false);

        await press(session, tab, W.tag);
        expect(reading<boolean>(tab, S.badged)).toBe(true);

        await press(session, tab, W.untag);
        expect(reading<boolean>(tab, S.badged)).toBe(false);
    });

    it('reaches no tab at all when it speaks, and faults nowhere doing it', async () => {
        const { session, tab } = await open();
        const bubble = `say:${TAG_SAID}`;

        await press(session, tab, W.say);
        // A bubble is in neither index and on no wire: `say` marks a `tag` op it never adds to the
        // authority's own index, and the broadcast drops every op under that prefix without a
        // bubble field to carry it instead. Nothing downstream of the call can observe it.
        expect(reading<string>(tab, S.marks)).toBe('');
        expect(runtimeOf(tab).tags.has(mine(tab), bubble)).toBe(false);

        await press(session, tab, W.clearSay);
        expect(session.trips).toEqual([]);
    });

    it('reports what it is touching, which needs a collider on both bodies', async () => {
        const { session, tab } = await open();
        // Walked onto the mark, which carries the same collider the avatar does.
        for (let i = 0; i < 6; i++) await press(session, tab, W.moveToward);
        await press(session, tab, W.readAll);
        expect(reading<number>(tab, S.touching)).toBeGreaterThan(0);
        // The predicate is defined as the list being non-empty, so the two may never disagree.
        expect(reading<boolean>(tab, S.contact)).toBe(true);
    });

    it('reports no contact for a body that has walked nowhere near another', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.readAll);
        expect(reading<number>(tab, S.touching)).toBe(0);
        expect(reading<boolean>(tab, S.contact)).toBe(false);
    });
});

describe('the entity verbs that hold no state', () => {
    it('think and stopAnimation chain, so a creator can go on writing', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.think);
        await press(session, tab, W.stopAnimation);
        expect(reading<number>(tab, S.inert)).toBe(2);
    });

    it('play and playEffect reach the effect sink without throwing', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.playClip);
        await press(session, tab, W.playEffect);
        expect(reading<number>(tab, S.effects)).toBe(2);
        expect(session.trips).toEqual([]);
    });
});

describe('a destroyed entity', () => {
    it('is gone from the tab that owned it, and says so where it is asked', async () => {
        const { session, tab } = await open();
        expect(avatarOf(tab)).toBeDefined();
        await press(session, tab, W.destroy);
        expect(reading<boolean>(tab, S.alive)).toBe(false);
        expect(avatarOf(tab)).toBeUndefined();
    });
});

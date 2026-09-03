// The three motion helpers, started from a game and watched on a client.
//
// Two of them are per-tick timers on the authority, so what a tab holds is a SAMPLE of a body that
// never stops moving — and every claim below is one that survives sampling: an invariant true at
// every tick, an envelope, or a reading that repeats exactly one period later. Reading the authority
// instead would prove the arithmetic and nothing about what a player is shown.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { gameField, newSession, runtimeOf, taggedIn, transformIn } from './harness.js';
import { SIM_RATE } from '../dist/world.js';
import {
    DIAL_FAR,
    DIAL_NEAR,
    DIAL_SLOW_SECONDS,
    DOT_AT,
    DOT_FADE_TO,
    DOT_SLIDE_TO,
    HUB_AT,
    HUB_SHIFT,
    MOTION_WORLD,
    ORBIT_RADIUS,
    ORBIT_SPEED,
    RACE_SECONDS,
    RACE_TO,
    S,
    SWING_AMOUNT,
    SWING_SECONDS,
    SWING_X_AT,
    SWING_Y_AT,
    TAG_DOT,
    TAG_MOON,
    TAG_SWING_X,
    TAG_SWING_Y,
    TILT_FAR,
    TWEEN_SECONDS,
    W,
} from '../dist/worlds/motion.js';

type Point = { x: number; y: number };

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
const SWING_TICKS = SWING_SECONDS * SIM_RATE;
const REV_TICKS = Math.round(((2 * Math.PI) / ORBIT_SPEED) * SIM_RATE);
const TWEEN_TICKS = Math.ceil(TWEEN_SECONDS * SIM_RATE) + SETTLE;
const SLOW_TICKS = Math.ceil(DIAL_SLOW_SECONDS * SIM_RATE) + SETTLE;
const RACE_TICKS = Math.ceil(RACE_SECONDS * SIM_RATE) + SETTLE;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(MOTION_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

/** One tagged prop as this tab's own mirror holds it. */
function propOf(tab: Tab, tag: string): EntityId {
    const id = taggedIn(runtimeOf(tab), tag)[0];
    if (id === undefined) throw new Error(`no ${tag} in the mirror`);
    return id;
}

function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

/** Where the mirror puts a body, once per tick, for as long as asked. */
async function trail(
    session: Session,
    tab: Tab,
    id: EntityId,
    ticks: number,
): Promise<readonly Point[]> {
    const path: Point[] = [];
    for (let i = 0; i < ticks; i++) {
        await session.step(1);
        const at = transformIn(runtimeOf(tab), id);
        path.push({ x: at.x, y: at.y });
    }
    return path;
}

const hi = (xs: readonly number[]): number => xs.reduce((a, b) => Math.max(a, b), -Infinity);
const lo = (xs: readonly number[]): number => xs.reduce((a, b) => Math.min(a, b), Infinity);

/** The worst a series differs from itself `lag` samples on — zero when `lag` is a true period. */
function driftOver(series: readonly number[], lag: number): number {
    let worst = 0;
    series.forEach((v, i) => {
        const later = series[i + lag];
        if (later !== undefined) worst = Math.max(worst, Math.abs(later - v));
    });
    return worst;
}

/** How far the worst sample strays from a circle of `ORBIT_RADIUS` about `centre`. */
function radiusError(path: readonly Point[], centre: Point): number {
    return path.reduce(
        (worst, p) =>
            Math.max(worst, Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - ORBIT_RADIUS)),
        0,
    );
}

function quadrantOf(p: Point, centre: Point): number {
    return (p.x >= centre.x ? 0 : 1) + (p.y >= centre.y ? 0 : 2);
}

describe('a body told to oscillate', () => {
    it('reaches a full amplitude either side of where it started and goes no further', async () => {
        const { session, tab } = await open();
        const swinger = propOf(tab, TAG_SWING_X);
        expect(transformIn(runtimeOf(tab), swinger).x).toBe(SWING_X_AT.x);

        await press(session, tab, W.swingX);
        const xs = (await trail(session, tab, swinger, SWING_TICKS)).map((p) => p.x);

        expect(hi(xs)).toBeLessThanOrEqual(SWING_X_AT.x + SWING_AMOUNT);
        expect(lo(xs)).toBeGreaterThanOrEqual(SWING_X_AT.x - SWING_AMOUNT);
        // A tab is told a position every third tick, so the sample nearest a peak is at most a tick
        // and a half short of one.
        expect(hi(xs)).toBeGreaterThan(SWING_X_AT.x + SWING_AMOUNT * 0.99);
        expect(lo(xs)).toBeLessThan(SWING_X_AT.x - SWING_AMOUNT * 0.99);
        // Centred on where it began, which is the claim that it returns rather than drifts.
        expect((hi(xs) + lo(xs)) / 2).toBeCloseTo(SWING_X_AT.x, 3);
    });

    it('is on the very reading it held one period earlier, not merely near it', async () => {
        const { session, tab } = await open();
        const swinger = propOf(tab, TAG_SWING_X);
        await press(session, tab, W.swingX);

        const xs = (await trail(session, tab, swinger, SWING_TICKS * 2)).map((p) => p.x);
        // The sine has the same argument and the tab is the same whole number of send intervals
        // behind, so the two readings agree to the last bit the wire carried.
        expect(driftOver(xs, SWING_TICKS)).toBeLessThan(1e-6);
    });

    it('moves the one axis it was named and leaves the other exactly where it was', async () => {
        const { session, tab } = await open();
        const swinger = propOf(tab, TAG_SWING_Y);
        await press(session, tab, W.swingY);

        const path = await trail(session, tab, swinger, SWING_TICKS);
        const ys = path.map((p) => p.y);
        expect(hi(ys)).toBeGreaterThan(SWING_Y_AT.y + SWING_AMOUNT * 0.99);
        expect(lo(ys)).toBeLessThan(SWING_Y_AT.y - SWING_AMOUNT * 0.99);

        const xs = path.map((p) => p.x);
        expect(hi(xs)).toBe(SWING_Y_AT.x);
        expect(lo(xs)).toBe(SWING_Y_AT.x);
    });
});

describe('a body told to orbit', () => {
    it('lifts onto a ring about the centre and holds that radius at every tick', async () => {
        const { session, tab } = await open();
        const moon = propOf(tab, TAG_MOON);
        expect(transformIn(runtimeOf(tab), moon).x).toBe(HUB_AT.x);
        expect(transformIn(runtimeOf(tab), moon).y).toBe(HUB_AT.y);

        await press(session, tab, W.orbit);
        const path = await trail(session, tab, moon, REV_TICKS * 2);
        expect(radiusError(path, HUB_AT)).toBeLessThan(1e-6);
    });

    it('comes right round in 2π over speed seconds, so its speed is radians a second', async () => {
        const { session, tab } = await open();
        const moon = propOf(tab, TAG_MOON);
        await press(session, tab, W.orbit);
        const path = await trail(session, tab, moon, REV_TICKS * 2);

        // All four quadrants inside one revolution: read as degrees a second the same body would
        // still be a few degrees from where it set off.
        const quadrants = new Set(path.slice(0, REV_TICKS).map((p) => quadrantOf(p, HUB_AT)));
        expect(quadrants.size).toBe(4);

        const xs = path.map((p) => p.x);
        const ys = path.map((p) => p.y);
        expect(driftOver(xs, REV_TICKS)).toBeLessThan(1e-6);
        expect(driftOver(ys, REV_TICKS)).toBeLessThan(1e-6);
    });

    it('keeps circling where the centre stood, not where the centre went', async () => {
        const { session, tab } = await open();
        const moon = propOf(tab, TAG_MOON);
        await press(session, tab, W.orbit);
        await press(session, tab, W.shiftHub);

        // The centre is read once, at the call, so a centre that is an entity is a point and not a
        // subscription — moving it afterwards leaves the ring where it was.
        const path = await trail(session, tab, moon, REV_TICKS);
        expect(radiusError(path, HUB_AT)).toBeLessThan(1e-6);
        expect(radiusError(path, { x: HUB_AT.x + HUB_SHIFT, y: HUB_AT.y })).toBeGreaterThan(
            HUB_SHIFT / 2,
        );
    });
});

describe('a tween on a plain object', () => {
    it('carries every numeric prop it names, and settles once the last of them lands', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.dialFar, SLOW_TICKS);
        await press(session, tab, W.readDial);

        expect(reading<number>(tab, S.level)).toBeCloseTo(DIAL_FAR, 3);
        expect(reading<number>(tab, S.tilt)).toBeCloseTo(TILT_FAR, 3);
        expect(reading<number>(tab, S.settled)).toBe(1);
    });

    it('runs the eased prop ahead of the linear one all the way to the same target', async () => {
        const { session, tab } = await open();
        session.press(tab, W.race);
        await session.step(4);
        await press(session, tab, W.readDial);

        const eased = reading<number>(tab, S.level) ?? 0;
        const straight = reading<number>(tab, S.tilt) ?? 0;
        expect(straight).toBeGreaterThan(0);
        expect(eased).toBeGreaterThan(straight);
        expect(eased).toBeLessThan(RACE_TO);

        await session.step(RACE_TICKS);
        await press(session, tab, W.readDial);
        expect(reading<number>(tab, S.level)).toBeCloseTo(RACE_TO, 3);
        expect(reading<number>(tab, S.tilt)).toBeCloseTo(RACE_TO, 3);
    });

    it('re-aims only the prop a second tween names, and never resumes the one it replaced', async () => {
        const { session, tab } = await open();

        session.press(tab, W.dialFar);
        await session.step(6);
        await press(session, tab, W.readDial);
        const started = reading<number>(tab, S.level) ?? 0;
        expect(started).toBeGreaterThan(0);
        expect(started).toBeLessThan(DIAL_FAR);

        await press(session, tab, W.dialNear, TWEEN_TICKS);
        await press(session, tab, W.readDial);
        expect(reading<number>(tab, S.level)).toBeCloseTo(DIAL_NEAR, 3);
        // `tilt` was never named twice, so the slow tween is still carrying it.
        const midTilt = reading<number>(tab, S.tilt) ?? 0;
        expect(midTilt).toBeGreaterThan(0);
        expect(midTilt).toBeLessThan(TILT_FAR);

        await session.step(SLOW_TICKS);
        await press(session, tab, W.readDial);
        expect(reading<number>(tab, S.level)).toBeCloseTo(DIAL_NEAR, 3);
        expect(reading<number>(tab, S.tilt)).toBeCloseTo(TILT_FAR, 3);
        // Two, because the replaced tween resolved the moment it was cancelled rather than hanging
        // the handler that awaited it.
        expect(reading<number>(tab, S.settled)).toBe(2);
    });
});

describe('a tween aimed at an entity', () => {
    it('reaches the one transform the facade publishes as a settable property', async () => {
        const { session, tab } = await open();
        const dot = propOf(tab, TAG_DOT);
        expect(transformIn(runtimeOf(tab), dot).opacity).toBe(1);

        await press(session, tab, W.fadeDot, TWEEN_TICKS);
        expect(transformIn(runtimeOf(tab), dot).opacity).toBeCloseTo(DOT_FADE_TO, 3);
    });

    it('lands its number on the facade instead of the body when it is aimed at x', async () => {
        const { session, tab } = await open();
        const dot = propOf(tab, TAG_DOT);
        expect(transformIn(runtimeOf(tab), dot).x).toBe(DOT_AT.x);

        await press(session, tab, W.slideDot, TWEEN_TICKS);
        // `tween` builds its target by plain property get and set for everything, never routing an
        // Entity through the transform-backed target its own glide verbs use — and `Entity` has no
        // `x` accessor for that to reach. The tween ran, and it ran on a field it invented.
        expect(reading<number>(tab, S.shadow)).toBeCloseTo(DOT_SLIDE_TO, 3);
        expect(transformIn(runtimeOf(tab), dot).x).toBe(DOT_AT.x);
        expect(session.trips).toEqual([]);
    });
});

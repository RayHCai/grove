// What a tab does when the authority disagrees with what it already drew.
//
// Every other suite here asserts that a mirror AGREES with the server. That is the easy half: a
// well-behaved game never disagrees, so the branch that reconciles a disagreement is never entered
// and the ease/snap decision goes untested against a real authority.
//
// These cases make the server disagree on purpose, either side of the client's snap threshold, and
// read the decision off the prediction counters. The drawn-pose lag that distinguishes an ease
// frame-by-frame is not reachable from here — the render bridge is private on the client — so what
// is pinned is the decision and the convergence, not the interpolation curve.

import { describe, expect, it } from 'vitest';
import type { Session, Tab } from './harness.js';
import { avatarIn, newSession, runtimeOf, transformIn } from './harness.js';
import { CODE_PUSH, CORRECTION_WORLD, HURL, NUDGE, START, W } from '../dist/worlds/correction.js';

const SETTLE = 12;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(CORRECTION_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

function snaps(tab: Tab): number {
    return tab.client.prediction?.counters.snappedCorrections ?? 0;
}

/** Where this tab's own avatar stands, in whichever world is asked. */
function xIn(session: Session, tab: Tab, mirror: boolean): number {
    const rt = mirror ? runtimeOf(tab) : session.sim.runtime;
    const me = tab.client.localPlayer?.id;
    if (me === undefined) throw new Error('no local player');
    const avatar = avatarIn(rt, me);
    if (avatar === undefined) throw new Error('no avatar');
    return transformIn(rt, avatar).x;
}

/** Predicting, which is the state a correction is only possible from. */
async function predicting(session: Session, tab: Tab): Promise<void> {
    session.hold(tab, CODE_PUSH);
    await session.step(SETTLE);
    expect(xIn(session, tab, true)).toBeGreaterThan(START.x);
}

/**
 * Stops the input and lets the tab settle onto the authority.
 *
 * A predicting tab is deliberately AHEAD of the server by its input lead, so the two agree only
 * once there is no unacknowledged input left to replay — comparing them mid-hold would be asserting
 * that prediction does not happen.
 */
async function rest(session: Session, tab: Tab): Promise<void> {
    session.releaseAll();
    await session.step(SETTLE * 3);
    expect(xIn(session, tab, true)).toBeCloseTo(xIn(session, tab, false), 3);
}

describe('a disagreement inside the snap threshold', () => {
    it('is eased rather than snapped, and the tab still lands on the authority', async () => {
        const { session, tab } = await open();
        await predicting(session, tab);

        session.press(tab, W.nudge);
        await session.step(SETTLE * 2);

        // Under the threshold, so the difference is smoothed into the drawn pose and the counter
        // that records giving up on smoothing stays where it was.
        expect(snaps(tab)).toBe(0);
        // The simulation itself takes the authority's number outright — easing is a display
        // concession, never a second opinion about where the entity is.
        await rest(session, tab);
    });

    it('carries the displacement the authority made, not the one the tab predicted', async () => {
        const { session, tab } = await open();
        const before = xIn(session, tab, false);

        session.press(tab, W.nudge);
        await session.step(SETTLE * 2);

        // The tab never ran `Hand`, so this distance is one it could not have arrived at by replay.
        expect(xIn(session, tab, false) - before).toBeCloseTo(NUDGE, 3);
        expect(xIn(session, tab, true)).toBeCloseTo(xIn(session, tab, false), 3);
    });
});

describe('a disagreement past the snap threshold', () => {
    it('snaps, because easing a teleport would draw a slide the simulation never made', async () => {
        const { session, tab } = await open();
        await predicting(session, tab);
        expect(snaps(tab)).toBe(0);

        session.press(tab, W.hurl);
        await session.step(SETTLE * 2);

        expect(snaps(tab)).toBeGreaterThan(0);
        await rest(session, tab);
    });

    it('tells the two branches apart on size alone, from the same starting state', async () => {
        const eased = await open();
        await predicting(eased.session, eased.tab);
        eased.session.press(eased.tab, W.nudge);
        await eased.session.step(SETTLE * 2);

        const snapped = await open();
        await predicting(snapped.session, snapped.tab);
        snapped.session.press(snapped.tab, W.hurl);
        await snapped.session.step(SETTLE * 2);

        // Same world, same input, same handler — only the distance differs, and it is the distance
        // the threshold reads.
        expect(snaps(eased.tab)).toBe(0);
        expect(snaps(snapped.tab)).toBeGreaterThan(0);
        expect(HURL).toBeGreaterThan(NUDGE);
    });
});

describe('a corrected tab', () => {
    it('goes on predicting afterwards rather than giving up on the avatar', async () => {
        const { session, tab } = await open();
        await predicting(session, tab);
        session.press(tab, W.hurl);
        await session.step(SETTLE * 2);

        const after = xIn(session, tab, true);
        // Still holding the key, so a tab that stopped replaying its own input would sit still here.
        await session.step(SETTLE);
        expect(xIn(session, tab, true)).toBeGreaterThan(after);

        await rest(session, tab);
        expect(session.trips).toEqual([]);
    });
});

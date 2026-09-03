// The timer API, driven through a game and read back off a client.
//
// Each case presses a widget, the handler behind it registers a duration on the authority, and the
// count of firings reaches this tab a replication interval later. Asserting on the MIRROR is the
// point: a timer that fired on the server without marking the state it wrote would pass a unit test
// and leave a HUD frozen here.

import { describe, expect, it } from 'vitest';
import type { Session, Tab } from './harness.js';
import { gameField, newSession, runtimeOf } from './harness.js';
import {
    AFTER_TICKS,
    EVERY_TICKS,
    NAP_TICKS,
    S,
    TICKER_NAP_TICKS,
    TIMER_WORLD,
    W,
} from '../dist/worlds/timers.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
const PAST_AFTER = AFTER_TICKS + SETTLE * 2;
const PAST_NAP = NAP_TICKS + SETTLE * 2;
const PAST_TICKER_NAP = TICKER_NAP_TICKS + SETTLE * 2;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(TIMER_WORLD);
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

function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

describe('a one-shot timer', () => {
    it('fires at its due time, once, and never again', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armAfter);
        // Well short of the duration: a timer that fired on registration would already read 1.
        expect(reading<number>(tab, S.afterFires)).toBe(0);

        await session.step(PAST_AFTER);
        expect(reading<number>(tab, S.afterFires)).toBe(1);

        // Twice the duration again, because a one-shot left in the heap would spend itself twice.
        await session.step(PAST_AFTER);
        expect(reading<number>(tab, S.afterFires)).toBe(1);
    });

    it('is stopped for good by the handle it returned', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armAfter);
        await press(session, tab, W.stopAfter);

        await session.step(PAST_AFTER * 2);
        expect(reading<number>(tab, S.afterFires)).toBe(0);
        expect(session.trips).toEqual([]);
    });
});

describe('a repeating timer', () => {
    it('holds its interval rather than slipping a tick per firing', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armEvery, EVERY_TICKS * 10);

        expect(reading<number>(tab, S.everyFires)).toBeGreaterThanOrEqual(5);
        // The gap is counted in the game's own update passes, so a reload that dated itself from
        // the tick it fired on rather than from its due tick shows up as a gap that grew.
        expect(reading<number>(tab, S.everyGap)).toBe(EVERY_TICKS);
        expect(reading<boolean>(tab, S.everyDrifted)).toBe(false);
    });

    it('stops where its handle was called, and a second call is not an error', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armEvery, EVERY_TICKS * 6);
        await press(session, tab, W.stopEvery);
        // Twice: the handle closes over an id the first call has already taken out of the heap.
        await press(session, tab, W.stopEvery, SETTLE * 2);

        const stopped = reading<number>(tab, S.everyFires);
        expect(stopped).toBeGreaterThanOrEqual(3);

        await session.step(EVERY_TICKS * 20);
        expect(reading<number>(tab, S.everyFires)).toBe(stopped);
        expect(session.trips).toEqual([]);
    });
});

describe('a sleeping handler', () => {
    it('parks at the await and resumes past it when the duration is up', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.nap);
        // The line before the await ran on the interaction frame; the line after it has not.
        expect(reading<number>(tab, S.napStarted)).toBe(1);
        expect(reading<number>(tab, S.napEnded)).toBe(0);

        await session.step(PAST_NAP);
        expect(reading<number>(tab, S.napEnded)).toBe(1);
    });

    it('wakes a handler an entity parked, not only one the game did', async () => {
        const { session, tab } = await open();
        expect(reading<boolean>(tab, S.tickerWoke)).toBe(false);

        await session.step(PAST_TICKER_NAP);
        expect(reading<boolean>(tab, S.tickerWoke)).toBe(true);
    });
});

describe('a duration shorter than a tick', () => {
    it('rounds up to exactly one tick, firing once a tick and no more', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armSub, SETTLE * 4);

        const sub = reading<number>(tab, S.subFires);
        expect(sub).toBeGreaterThan(20);
        // Against a one-tick repeat and against the sim's own update pass. All three counts are
        // written on the same tick, so replication lag cancels and the comparison is exact.
        expect(reading<number>(tab, S.tickFires)).toBe(sub);
        expect(reading<number>(tab, S.armedTicks)).toBe(sub);
    });

    it('makes a zero-second one-shot due on the tick a one-tick repeat fires', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.armSub);
        // One, not zero: zero seconds means the NEXT tick, never the tick that asked for it.
        expect(reading<number>(tab, S.zeroAfterAt)).toBe(1);
    });
});

describe('a destroyed host', () => {
    it('takes the repeat it was running with it', async () => {
        const { session, tab } = await open();
        const before = reading<number>(tab, S.tickerFires) ?? 0;
        await session.step(EVERY_TICKS * 6);
        // Climbing before the kill, so a count that stops afterwards is the destroy and not a
        // timer that had already run itself out.
        const running = reading<number>(tab, S.tickerFires) ?? 0;
        expect(running).toBeGreaterThan(before);

        await press(session, tab, W.killTicker, SETTLE * 3);
        const frozen = reading<number>(tab, S.tickerFires) ?? 0;
        expect(frozen).toBeGreaterThanOrEqual(running);

        await session.step(TICKER_NAP_TICKS);
        expect(reading<number>(tab, S.tickerFires)).toBe(frozen);
    });

    it('never wakes the sleep it had parked', async () => {
        const { session, tab } = await open();
        // The margin the long duration buys: the nap is still parked when the host dies.
        expect(reading<boolean>(tab, S.tickerWoke)).toBe(false);
        await press(session, tab, W.killTicker);

        await session.step(PAST_TICKER_NAP);
        // A cancelled sleep never resolves, so nothing downstream of that await ever runs — and
        // nothing faults where the continuation would have been.
        expect(reading<boolean>(tab, S.tickerWoke)).toBe(false);
        expect(session.trips).toEqual([]);
    });
});

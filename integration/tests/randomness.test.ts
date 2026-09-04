// The seeded stream, driven through a game and read off a client.
//
// Determinism is the whole claim, so nearly every case compares a digest of many draws rather than
// one number — one number agrees by luck often enough to pass a broken stream. The readings are the
// raw values a client was told, so the range, the membership and the spread are all checked HERE
// rather than by the world that drew them.

import { describe, expect, it } from 'vitest';
import type { Session, Tab } from './harness.js';
import { gameField, newSession, runtimeOf } from './harness.js';
import {
    DRAWS,
    PICKS,
    POINTS,
    POOL_BOUNDS,
    RANDOMNESS_WORLD,
    RANGE,
    S,
    SPECIES,
    SURE_TRIALS,
    TRIALS,
    W,
} from '../dist/worlds/randomness.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(RANDOMNESS_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string): Promise<void> {
    session.press(tab, widget);
    await session.step(SETTLE);
}

/** One replicated reading off this tab's own mirror, never off the authority that wrote it. */
function reading(tab: Tab, field: string): string {
    return gameField<string>(runtimeOf(tab), field) ?? '';
}

function numberIn(tab: Tab, field: string): number | undefined {
    return gameField<number>(runtimeOf(tab), field);
}

/** The values a digest carries, back as numbers, so the test can do its own arithmetic on them. */
function values(digest: string): number[] {
    return digest.split('|').map((raw) => Number(raw));
}

function pointsIn(spots: string): Array<{ x: number; y: number }> {
    return spots.split('|').map((spot) => {
        const [x, y] = spot.split(',');
        return { x: Number(x), y: Number(y) };
    });
}

describe('a stream nobody seeded', () => {
    it('draws the same numbers in two sessions built from the same world', async () => {
        const first = await open();
        const second = await open();

        for (const at of [first, second]) {
            await press(at.session, at.tab, W.draw);
            await press(at.session, at.tab, W.pick);
            await press(at.session, at.tab, W.chance);
            await press(at.session, at.tab, W.pointIn);
        }

        // Four surfaces rather than one: they share a stream, so a draw that went missing in any of
        // them shifts every reading after it.
        expect(reading(first.tab, S.digest)).toBe(reading(second.tab, S.digest));
        expect(reading(first.tab, S.picked)).toBe(reading(second.tab, S.picked));
        expect(reading(first.tab, S.coins)).toBe(reading(second.tab, S.coins));
        expect(reading(first.tab, S.spots)).toBe(reading(second.tab, S.spots));
        // The guard on all four: agreement is evidence only if there was room to disagree.
        expect(values(reading(first.tab, S.digest))).toHaveLength(DRAWS);
    });

    it('tells a client the numbers it drew rather than letting it draw its own', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.draw);

        const authority = gameField<string>(session.sim.runtime, S.digest);
        expect(authority).not.toBe('');
        expect(reading(tab, S.digest)).toBe(authority);
    });
});

describe('seeding', () => {
    it('restarts the stream, so the same seed replays the same draws', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.seedA);
        await press(session, tab, W.draw);
        const fromA = reading(tab, S.digest);

        await press(session, tab, W.seedB);
        await press(session, tab, W.draw);
        expect(reading(tab, S.digest)).not.toBe(fromA);

        // Back to A by way of B rather than twice in a row: the mirror has to be TOLD the first
        // digest again, where an unchanged field would have been sent nothing and still passed.
        await press(session, tab, W.seedA);
        await press(session, tab, W.draw);
        expect(reading(tab, S.digest)).toBe(fromA);
    });

    it('goes on advancing when nobody reseeds it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.draw);
        const first = reading(tab, S.digest);

        await press(session, tab, W.draw);
        expect(reading(tab, S.digest)).not.toBe(first);
    });
});

describe('a draw between two numbers', () => {
    it('stays inside the half-open range it was given, and spreads across it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.draw);

        const drawn = values(reading(tab, S.digest));
        expect(drawn).toHaveLength(DRAWS);
        for (const value of drawn) {
            expect(value).toBeGreaterThanOrEqual(RANGE.min);
            expect(value).toBeLessThan(RANGE.max);
        }
        // Not a probabilistic claim: the seed is fixed, so this run is every run.
        expect(new Set(drawn).size).toBe(DRAWS);
    });
});

describe('a pick from a list', () => {
    it('only ever answers with a member of the list, and reaches more than one', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.pick);

        const taken = reading(tab, S.picked).split(',');
        expect(taken).toHaveLength(PICKS);
        for (const one of taken) expect(SPECIES).toContain(one);
        expect(new Set(taken).size).toBeGreaterThan(1);
    });
});

describe('a weighted chance', () => {
    it('is never true at zero, always true at one, and both ways in between', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.chance);

        expect(reading(tab, S.atOne)).toBe('1'.repeat(SURE_TRIALS));
        expect(reading(tab, S.atZero)).toBe('0'.repeat(SURE_TRIALS));

        const coins = reading(tab, S.coins);
        expect(coins).toHaveLength(TRIALS);
        expect(coins).toContain('1');
        expect(coins).toContain('0');
    });
});

describe('a point in a region', () => {
    it('lands inside the rectangle the project authored, somewhere new each draw', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.pointIn);

        const spots = pointsIn(reading(tab, S.spots));
        expect(spots).toHaveLength(POINTS);
        for (const spot of spots) {
            expect(spot.x).toBeGreaterThanOrEqual(POOL_BOUNDS.left);
            expect(spot.x).toBeLessThan(POOL_BOUNDS.right);
            expect(spot.y).toBeGreaterThanOrEqual(POOL_BOUNDS.bottom);
            expect(spot.y).toBeLessThan(POOL_BOUNDS.top);
        }
        expect(new Set(spots.map((spot) => `${spot.x},${spot.y}`)).size).toBe(POINTS);
    });

    it('answers the world origin for a region nobody authored, drawing nothing', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.seedA);
        await press(session, tab, W.pointStray);
        // Neither a throw nor a fault: an unauthored name resolves to no bounds and the miss comes
        // back as the zero vector, which every world will happily accept as a place to stand.
        expect(numberIn(tab, S.strayX)).toBe(0);
        expect(numberIn(tab, S.strayY)).toBe(0);

        await press(session, tab, W.draw);
        const afterMiss = reading(tab, S.digest);

        await press(session, tab, W.seedB);
        await press(session, tab, W.draw);
        expect(reading(tab, S.digest)).not.toBe(afterMiss);

        await press(session, tab, W.seedA);
        await press(session, tab, W.draw);
        // Same seed, no stray point, same digest: the miss returned before it reached the stream.
        expect(reading(tab, S.digest)).toBe(afterMiss);
        expect(session.trips).toEqual([]);
    });
});

describe("the Game facade's own random", () => {
    it('draws from the stream the ambient random draws from, not a second one', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.seedA);
        await press(session, tab, W.draw);
        const ambient = reading(tab, S.digest);
        expect(ambient).not.toBe('');

        await press(session, tab, W.seedA);
        await press(session, tab, W.drawSplit);
        // Sources alternate every draw, so a `game.random` with a stream of its own would restart
        // the sequence on every other value and could not reproduce this.
        expect(reading(tab, S.mixed)).toBe(ambient);
    });
});

// The stateful wrappers, driven through a game and read back off a client.
//
// A wrapper marks its own replication channel from inside its mutating methods and travels as its
// own serialized form, so every case here presses a widget and then asserts on the MIRROR: a method
// that changed the authority's copy without marking, or a constructor argument that never rode the
// wire, would pass a unit test and fail here.
//
// The last describe is the claim only an integration suite can make — a wrapper written to a store
// by one session and handed back to the same identity by the next.

import { describe, expect, it } from 'vitest';
import { Inventory, Leaderboard, MemoryKVStore, Scoreboard, Team } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { gameField, mineField, newSession, playerField, runtimeOf } from './harness.js';
import {
    AWARD,
    COUNTDOWN_SECONDS,
    F,
    ITEM_GEM,
    ITEM_KEY,
    P,
    S,
    SET_TO,
    STORE_VALUE,
    TEAM_RED,
    UNREAD,
    W,
    WRAPPERS_WORLD,
} from '../dist/worlds/wrappers.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
/** Ticks that outlast the countdown this world builds, whatever the send rate rounds it to. */
const CLOCK_TICKS = Math.ceil(COUNTDOWN_SECONDS * 60) + SETTLE * 2;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(WRAPPERS_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

/** Two tabs, for the readings that are about a room rather than about a player. */
async function openTwo(): Promise<{ session: Session; one: Tab; two: Tab }> {
    const session = newSession(WRAPPERS_WORLD);
    const one = await session.join('one');
    const two = await session.join('two');
    await session.live(one, two);
    await session.step(SETTLE);
    return { session, one, two };
}

/** Presses one widget and settles, which is the whole shape of every case below. */
async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

/** A Game-hosted value as this tab's own mirror holds it. */
function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

function idOf(tab: Tab): string {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) throw new Error(`${tab.name} has no player yet`);
    return id;
}

describe('a scoreboard', () => {
    it('credits whoever pressed, with no player named in the call', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.award);
        expect(reading<number>(tab, S.mine)).toBe(AWARD);

        // Twice, because a `set` masquerading as an `add` would still read AWARD after one press.
        await press(session, tab, W.award);
        expect(reading<number>(tab, S.mine)).toBe(AWARD * 2);
    });

    it('overwrites a total outright, and clears every total it holds', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.award);
        await press(session, tab, W.setScore);
        expect(reading<number>(tab, S.mine)).toBe(SET_TO);

        await press(session, tab, W.resetScores);
        expect(reading<number>(tab, S.mine)).toBe(0);
        // The wrapper the tab holds is emptied too, rather than merely re-read as zero.
        expect(reading<Scoreboard>(tab, F.scores)?.serialize()).toEqual({
            kind: 'Scoreboard',
            scores: [],
        });
    });

    it('ranks the room, and both tabs are told the same order', async () => {
        const { session, one, two } = await openTwo();
        await press(session, one, W.award);
        await press(session, one, W.award);
        await press(session, two, W.award);
        for (const tab of [one, two]) expect(reading<string>(tab, S.leaders)).toBe('one,two');
    });
});

describe('a leaderboard', () => {
    it('keeps the best score under a high order and the lowest under a low one', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.award);
        await press(session, tab, W.bank);
        expect(reading<number>(tab, S.banked)).toBe(AWARD);
        expect(reading<number>(tab, S.floor)).toBe(AWARD);

        // One worse score submitted to both boards: the high one must refuse it and the low one take
        // it, which is the only reading that tells the two orders apart.
        await press(session, tab, W.setScore);
        await press(session, tab, W.bank);
        expect(reading<number>(tab, S.banked)).toBe(AWARD);
        expect(reading<number>(tab, S.floor)).toBe(SET_TO);
    });

    it('sends the order it sorts by, since a tab runs no script that could tell it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.award);
        await press(session, tab, W.bank);
        const best = reading<Leaderboard>(tab, F.best);
        expect(best).toBeInstanceOf(Leaderboard);
        expect(best?.serialize()).toEqual({
            kind: 'Leaderboard',
            order: 'high',
            scores: [[idOf(tab), AWARD]],
        });
        expect(reading<Leaderboard>(tab, F.worst)?.serialize()).toEqual({
            kind: 'Leaderboard',
            order: 'low',
            scores: [[idOf(tab), AWARD]],
        });
    });

    it('ranks a player against the room and lists the podium in that order', async () => {
        const { session, one, two } = await openTwo();
        await press(session, one, W.award);
        await press(session, one, W.award);
        await press(session, one, W.bank);
        await press(session, two, W.award);
        await press(session, two, W.bank);
        expect(reading<number>(two, S.rank)).toBe(2);
        expect(reading<string>(two, S.podium)).toBe(`one:${AWARD * 2},two:${AWARD}`);
    });
});

describe("a player's inventory", () => {
    it('stacks by the count it was given and defaults to one', async () => {
        const { session, tab } = await open();
        // The wrapper knows whose it is, which is the constructor argument answering for itself.
        expect(mineField<string>(tab, P.owner)).toBe('one');

        await press(session, tab, W.stock);
        expect(mineField<number>(tab, P.keys)).toBe(2);
        expect(mineField<number>(tab, P.gems)).toBe(1);
        expect(mineField<boolean>(tab, P.carrying)).toBe(true);

        // Revived on the tab and rebound there: `Inventory` is the one wrapper whose constructor
        // argument has to be found on the roster before the payload can become an object at all.
        const bag = mineField<Inventory>(tab, F.bag);
        expect(bag).toBeInstanceOf(Inventory);
        expect(bag?.count(ITEM_KEY)).toBe(2);
        expect(bag?.has(ITEM_GEM)).toBe(true);
        expect(bag?.player.id).toBe(idOf(tab));
    });

    it('takes one back at a time and forgets an item that runs out', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.stock);
        await press(session, tab, W.spend);
        expect(mineField<number>(tab, P.keys)).toBe(1);
        expect(mineField<boolean>(tab, P.carrying)).toBe(true);

        await press(session, tab, W.spend);
        expect(mineField<number>(tab, P.keys)).toBe(0);
        expect(mineField<boolean>(tab, P.carrying)).toBe(false);
        // The gem is untouched: `remove` names one item and never the whole bag.
        expect(mineField<number>(tab, P.gems)).toBe(1);
    });

    it("empties on clear, and no tab is ever told another's bag", async () => {
        const { session, one, two } = await openTwo();
        await press(session, one, W.stock);
        // Host decides scope: a Player-hosted field reaches that player and no other tab.
        expect(playerField<number>(runtimeOf(two), idOf(one), P.keys)).toBeUndefined();
        expect(playerField<unknown>(runtimeOf(two), idOf(one), F.bag)).toBeUndefined();

        await press(session, one, W.emptyBag);
        expect(mineField<number>(one, P.keys)).toBe(0);
        expect(mineField<number>(one, P.gems)).toBe(0);
    });
});

describe('a team', () => {
    it('takes a player in and out, and names its roster to every tab', async () => {
        const { session, one, two } = await openTwo();
        await press(session, one, W.joinTeam);
        await press(session, two, W.joinTeam);
        for (const tab of [one, two]) {
            expect(reading<string>(tab, S.squad)).toBe(`${TEAM_RED}:one/two`);
        }

        await press(session, one, W.leaveTeam);
        expect(reading<string>(one, S.squad)).toBe(`${TEAM_RED}:two`);
        // Read for whoever pressed, so this is `has` answering about the player who just left.
        expect(reading<boolean>(one, S.onTeam)).toBe(false);
    });

    it('carries its name across the wire, so a tab knows which team it was handed', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.joinTeam);
        const team = reading<Team>(tab, F.red);
        expect(team).toBeInstanceOf(Team);
        expect(team?.name).toBe(TEAM_RED);
        expect(team?.serialize()).toEqual({
            kind: 'Team',
            name: TEAM_RED,
            members: [idOf(tab)],
        });
    });
});

describe('a countdown', () => {
    it('runs down while started and freezes where a pause left it', async () => {
        const { session, tab } = await open();
        expect(reading<boolean>(tab, S.ticking)).toBe(false);
        expect(reading<number>(tab, S.remains)).toBe(COUNTDOWN_SECONDS);

        await press(session, tab, W.startClock);
        expect(reading<boolean>(tab, S.ticking)).toBe(true);
        const running = reading<number>(tab, S.remains) ?? 0;
        expect(running).toBeLessThan(COUNTDOWN_SECONDS);
        expect(running).toBeGreaterThan(0);

        await press(session, tab, W.pauseClock);
        expect(reading<boolean>(tab, S.ticking)).toBe(false);
        const paused = reading<number>(tab, S.remains) ?? 0;
        expect(paused).toBeGreaterThan(0);

        // Nothing advances it now: the countdowns pass walks only what `start` enrolled.
        await session.step(SETTLE * 2);
        expect(reading<number>(tab, S.remains)).toBe(paused);
        expect(reading<number>(tab, S.rang)).toBe(0);
    });

    it('fires its callback at zero, once, and stops itself there', async () => {
        const { session, tab } = await open();
        // Well past zero, so a callback that fired per tick afterwards would be counted here.
        await press(session, tab, W.startClock, CLOCK_TICKS);
        expect(reading<number>(tab, S.rang)).toBe(1);
        expect(reading<boolean>(tab, S.ticking)).toBe(false);
        expect(reading<number>(tab, S.remains)).toBe(0);
    });
});

describe('a wrapper on the wire', () => {
    it('arrives as its own class and is updated in place rather than replaced', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.award);
        const first = reading<Scoreboard>(tab, F.scores);
        expect(first).toBeInstanceOf(Scoreboard);

        await press(session, tab, W.award);
        // The same object: a script may be holding it, so a diff restores the wrapper already there
        // instead of dropping the decoded payload over it and leaving a methodless one behind.
        expect(reading<Scoreboard>(tab, F.scores)).toBe(first);
        expect(first?.serialize()).toEqual({
            kind: 'Scoreboard',
            scores: [[idOf(tab), AWARD * 2]],
        });
    });
});

describe("a player's storage", () => {
    it('reads back what it wrote, and nothing under a key it deleted', async () => {
        const { session, tab } = await open();
        expect(mineField<number>(tab, P.stored)).toBe(UNREAD);

        await press(session, tab, W.keep);
        expect(mineField<number>(tab, P.stored)).toBe(STORE_VALUE);

        await press(session, tab, W.forget);
        expect(mineField<number>(tab, P.stored)).toBe(UNREAD);
        // The three handlers above are the only async ones in this world, so a store that rejected
        // or a continuation that wrote after its scope closed would show up here and nowhere else.
        expect(session.trips).toEqual([]);
    });

    it('is scoped to one player, so another reads nothing of theirs', async () => {
        const { session, one, two } = await openTwo();
        await press(session, one, W.keep);
        await press(session, two, W.recall);
        expect(mineField<number>(one, P.stored)).toBe(STORE_VALUE);
        expect(mineField<number>(two, P.stored)).toBe(UNREAD);
    });
});

describe('a player who comes back', () => {
    it('is handed the inventory they left with, and a stranger gets an empty one', async () => {
        const store = new MemoryKVStore();
        const first = newSession(WRAPPERS_WORLD, store);
        const tab = await first.join('one', 'ada');
        await first.live(tab);
        await first.step(SETTLE);
        await press(first, tab, W.stock);
        await press(first, tab, W.keep);
        expect(mineField<number>(tab, P.keys)).toBe(2);
        // The write-through happens on the close, so the leave is what banks the record.
        first.leave(tab);
        await first.step(SETTLE);
        first.dispose();

        // A second world over the same store, as a restarted process would be.
        const second = newSession(WRAPPERS_WORLD, store);
        const back = await second.join('one', 'ada');
        const stranger = await second.join('two', 'zed');
        await second.live(back, stranger);
        await second.step(SETTLE);

        expect(mineField<number>(back, P.keys)).toBe(2);
        expect(mineField<number>(back, P.gems)).toBe(1);
        expect(mineField<boolean>(back, P.carrying)).toBe(true);
        expect(mineField<number>(stranger, P.keys)).toBe(0);
        expect(mineField<boolean>(stranger, P.carrying)).toBe(false);

        // The store outlives the session too, and answers the identity that wrote it and no other.
        expect(mineField<number>(back, P.stored)).toBe(UNREAD);
        await press(second, back, W.recall);
        await press(second, stranger, W.recall);
        expect(mineField<number>(back, P.stored)).toBe(STORE_VALUE);
        expect(mineField<number>(stranger, P.stored)).toBe(UNREAD);
    });

    it("finds the game's own boards empty, since only a player's record is checkpointed", async () => {
        const store = new MemoryKVStore();
        const first = newSession(WRAPPERS_WORLD, store);
        const tab = await first.join('one', 'ada');
        await first.live(tab);
        await first.step(SETTLE);
        await press(first, tab, W.award);
        await press(first, tab, W.bank);
        expect(reading<number>(tab, S.banked)).toBe(AWARD);
        first.leave(tab);
        await first.step(SETTLE);
        first.dispose();

        const second = newSession(WRAPPERS_WORLD, store);
        const back = await second.join('one', 'ada');
        await second.live(back);
        await second.step(SETTLE);
        expect(reading<Scoreboard>(back, F.scores)?.serialize()).toEqual({
            kind: 'Scoreboard',
            scores: [],
        });
        // Submitting zero would lose to a persisted ten on a high board; it wins here because the
        // save path writes a departing player's record and nothing that hangs off the Game.
        await press(second, back, W.bank);
        expect(reading<number>(back, S.banked)).toBe(0);
    });
});

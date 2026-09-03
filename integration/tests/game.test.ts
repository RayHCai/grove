// The `Game` facade — the session, the world, and the four ways a world is queried — driven
// through a game and read back off a client.
//
// Every case presses a widget and settles, so the call runs in a handler on the authority and the
// answer reaches this tab a replication interval later. Three of these members do not do what they
// are specified to; those cases pin what the code DOES, with a comment saying exactly why.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { gameField, mineField, newSession, ofTemplate, runtimeOf, transformIn } from './harness.js';
import {
    AUTHORED_ENTITIES,
    BADGE_RANK,
    GAME_BOUNDS,
    GAME_WORLD,
    LEDGER_START,
    S,
    TAG_MARKED,
    TEMPLATE_DRIFTER,
    TEMPLATE_PROBE,
    TEMPLATE_SENTINEL,
    W,
    YARD,
} from '../dist/worlds/game.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(GAME_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

/** The one entity of a template only ever minted once, as this tab's own mirror holds it. */
function sole(tab: Tab, template: string): EntityId {
    const id = ofTemplate(runtimeOf(tab), template)[0];
    if (id === undefined) throw new Error(`no ${template} in the mirror`);
    return id;
}

describe('the world a game is', () => {
    it('names every player on its roster, numbered in the order they were seated', async () => {
        const session = newSession(GAME_WORLD);
        const first = await session.join('one');
        const second = await session.join('two');
        await session.live(first, second);
        await session.step(SETTLE);

        await press(session, first, W.roster);
        expect(reading<string>(first, S.crowd)).toBe('0:one,1:two');
        // Game-hosted, so the tab that did not press is told the same thing.
        expect(reading<string>(second, S.crowd)).toBe('0:one,1:two');
    });

    it('counts every live entity, and the tab was told about all of them', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.roster);
        expect(reading<number>(tab, S.census)).toBe(AUTHORED_ENTITIES + 1);
        expect(runtimeOf(tab).entities.liveIds().length).toBe(AUTHORED_ENTITIES + 1);
    });

    it('reports the extent the project was built with, not a runtime default', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.bounds);
        const edges = [GAME_BOUNDS.left, GAME_BOUNDS.right, GAME_BOUNDS.top, GAME_BOUNDS.bottom];
        expect(reading<string>(tab, S.extent)).toBe(edges.join(','));
    });
});

describe("a game's random", () => {
    it('repeats a sequence after the same seed, and moves on when it is not reseeded', async () => {
        const first = await open();
        await press(first.session, first.tab, W.roll);
        expect(reading<boolean>(first.tab, S.reseeded)).toBe(true);
        // The guard on the claim above: two draws agreeing proves a seed only if they could differ.
        expect(reading<boolean>(first.tab, S.advanced)).toBe(true);

        const drawn = reading<string>(first.tab, S.rolls);
        expect(drawn).not.toBe('');
        first.session.dispose();

        // A second world over the same seed, as a restarted process would be: the seed is the whole
        // input, so nothing wall-clock can have entered the stream.
        const second = await open();
        await press(second.session, second.tab, W.roll);
        expect(reading<string>(second.tab, S.rolls)).toBe(drawn);
    });

    it('draws a point inside the region it was named, and a spawn there reaches the tab', async () => {
        const { session, tab } = await open();
        expect(ofTemplate(runtimeOf(tab), TEMPLATE_PROBE)).toEqual([]);

        await press(session, tab, W.plant);
        const x = reading<number>(tab, S.yardX) ?? 0;
        const y = reading<number>(tab, S.yardY) ?? 0;
        expect(x).toBeGreaterThanOrEqual(YARD.left);
        expect(x).toBeLessThanOrEqual(YARD.right);
        expect(y).toBeGreaterThanOrEqual(YARD.bottom);
        expect(y).toBeLessThanOrEqual(YARD.top);

        // The number the authority drew is the point the client draws the sprite at.
        const at = transformIn(runtimeOf(tab), sole(tab, TEMPLATE_PROBE));
        expect(at.x).toBeCloseTo(x, 5);
        expect(at.y).toBeCloseTo(y, 5);
    });
});

describe('finding entities in a world', () => {
    it('answers by tag across the whole world, and narrows the same query to a region', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.count);
        expect(reading<number>(tab, S.byTag)).toBe(2);
        expect(reading<number>(tab, S.rocksInYard)).toBe(1);
    });

    it('counts what stands inside an authored region, and a spawn into it raises that', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.count);
        expect(reading<number>(tab, S.inYard)).toBe(1);

        await press(session, tab, W.plant);
        await press(session, tab, W.plant);
        await press(session, tab, W.count);
        expect(reading<number>(tab, S.inYard)).toBe(3);
    });

    it('honours the radius it was given rather than answering with the whole world', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.count);
        // Only the rock the query is centred on stands inside the tight radius, while the wide one
        // is longer than the world's diagonal and so must reach everything the census counted.
        expect(reading<number>(tab, S.nearTight)).toBe(1);
        expect(reading<number>(tab, S.nearWide)).toBe(reading<number>(tab, S.census));
    });
});

describe('a query asked for the world as it was seen', () => {
    it('answers from the last capture rather than from where the entity now stands', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.hop);
        // Pressed once, and the move and the queries share a handler: the ring captures at the END
        // of a tick, so the hop is not in it yet and the sentinel is still at home there.
        expect(reading<number>(tab, S.seenHome)).toBe(1);
        expect(reading<number>(tab, S.seenNear)).toBe(0);
        expect(reading<number>(tab, S.liveNear)).toBe(1);
    });

    it('leaves the region filter live under the same flag, and wants no view tick to answer', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.hop);
        // `asSeen` is read in the `near` branch alone, so this query filters the LIVE position and
        // finds the sentinel in the yard it has only just hopped into.
        expect(reading<number>(tab, S.seenIn)).toBe(1);
        // And a press carries no view tick at all. The spec has `asSeen` resolve against the tick
        // the asking client named, and raise at load from a handler carrying none; it does neither
        // — it takes the ring's most recent capture, unclamped, and answers.
        expect(reading<boolean>(tab, S.sawTick)).toBe(false);
        expect(session.trips).toEqual([]);
    });
});

describe('a paused game', () => {
    it('goes on ticking anyway, because nothing downstream reads the flag it sets', async () => {
        const { session, tab } = await open();
        const drifter = sole(tab, TEMPLATE_DRIFTER);
        const before = transformIn(runtimeOf(tab), drifter).x;

        await press(session, tab, W.halt);
        const held = transformIn(runtimeOf(tab), drifter).x;
        await session.step(SETTLE * 2);
        const later = transformIn(runtimeOf(tab), drifter).x;
        // `pause()` writes `rt.paused` and no accumulator in the stack reads it back, so the tick
        // that advances this entity runs exactly as it did before the press.
        expect(held).toBeGreaterThan(before);
        expect(later).toBeGreaterThan(held);

        // Resuming is therefore also inert, and the only honest claim left is that neither faults.
        await press(session, tab, W.go);
        await session.step(SETTLE * 2);
        expect(transformIn(runtimeOf(tab), drifter).x).toBeGreaterThan(later);
        expect(session.trips).toEqual([]);
    });
});

describe('reaching a script by its class', () => {
    it('finds the game script the manifest attached, and it is the instance that asked', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.selfScript);
        expect(reading<boolean>(tab, S.selfFound)).toBe(true);
    });

    // Both worlds live in one test because the second half only holds for the FIRST world of a
    // process to attach this class, and a separate test could not promise it ran first.
    it('attaches a second game script at runtime — once per process, not once per world', async () => {
        const first = await open();
        expect(reading<number>(first.tab, S.tally)).toBeUndefined();

        await press(first.session, first.tab, W.gameScript);
        expect(reading<boolean>(first.tab, S.ledgerWasThere)).toBe(false);
        expect(reading<boolean>(first.tab, S.ledgerIsThere)).toBe(true);
        // The starts pass drains a runtime attach on a later tick, so this value is the script's own
        // `@onStart` writing rather than its initializer being hoisted by the attach.
        expect(reading<number>(first.tab, S.tally)).toBe(LEDGER_START);
        first.session.dispose();

        // The hoist defined `tally` on the `game` const, which is a Proxy with no defineProperty
        // trap over ONE module-level target: the accessor lands on that target and outlives the
        // world it was hoisted for. So the next world refuses the same class as a name the Game
        // already answers to, the handler dies at the call, and one throw is under the breaker's
        // threshold — nothing anywhere is told.
        const second = await open();
        await press(second.session, second.tab, W.gameScript);
        expect(reading<boolean>(second.tab, S.ledgerWasThere)).toBe(false);
        expect(reading<boolean>(second.tab, S.ledgerIsThere)).toBe(false);
        expect(reading<number>(second.tab, S.tally)).toBeUndefined();
        expect(second.session.trips).toEqual([]);
    });

    it('attaches to an entity at runtime, and the tag that start writes reaches the tab', async () => {
        const { session, tab } = await open();
        const sentinel = sole(tab, TEMPLATE_SENTINEL);
        expect(runtimeOf(tab).tags.has(sentinel, TAG_MARKED)).toBe(false);

        await press(session, tab, W.entityScript);
        expect(reading<boolean>(tab, S.markWasThere)).toBe(false);
        expect(reading<boolean>(tab, S.markIsThere)).toBe(true);
        expect(runtimeOf(tab).tags.has(sentinel, TAG_MARKED)).toBe(true);
    });

    it("attaches to the pressing player, and that player's own tab is told the state", async () => {
        const { session, tab } = await open();
        expect(mineField<number>(tab, S.rank)).toBeUndefined();

        await press(session, tab, W.playerScript);
        expect(reading<boolean>(tab, S.badgeWasThere)).toBe(false);
        expect(reading<boolean>(tab, S.badgeIsThere)).toBe(true);
        expect(mineField<number>(tab, S.rank)).toBe(BADGE_RANK);
    });
});

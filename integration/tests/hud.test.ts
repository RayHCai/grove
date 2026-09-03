// The HUD, driven through the only kind of script that can reach one.
//
// `hud` resolves the CURRENT runtime's local player, so every call under test runs on the tab
// rather than the authority — and every assertion is made against `client.hud`, the sink a browser's
// UI layer actually draws from, rather than the state core holds behind it.
//
// `addScript` registers a class for the NEXT open, because `open` wires what the screen already
// holds and then returns on the visible flag forever after. The two cases at the foot of this file
// are what that rule costs a game that moves the flag itself.

import { describe, expect, it } from 'vitest';
import type { HUDWidgetState } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { newSession, runtimeOf } from './harness.js';
import { ASSET_DISC } from '../dist/world.js';
import {
    B,
    BAG_OPEN,
    BAG_SHUT,
    HUD_WORLD,
    LABEL_READY,
    METER_FRACTION,
    NONE,
    NOTHING,
    OVERFILL,
    RETIMED_SECONDS,
    SCREEN_BAG,
    SCREEN_DECK,
    TIMER_SECONDS,
    V,
} from '../dist/worlds/hud.js';

/** Ticks that comfortably outlast one send interval, so the tab has been answered. */
const SETTLE = 12;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(HUD_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

/** Presses one of a screen's buttons and settles, which is the shape of every case below. */
async function press(
    session: Session,
    tab: Tab,
    widget: string,
    screen = SCREEN_DECK,
): Promise<void> {
    session.press(tab, widget, screen);
    await session.step(SETTLE);
}

function drawn(tab: Tab, widget: string): Readonly<HUDWidgetState> | null {
    return tab.client.hud.widgetOf(widget);
}

function says(tab: Tab, widget: string): string | undefined {
    return drawn(tab, widget)?.text;
}

describe('a HUD widget', () => {
    it('is born shown and enabled, and what it says reaches the layer that draws it', async () => {
        const { tab } = await open();
        const label = drawn(tab, V.label);
        expect(label?.text).toBe(LABEL_READY);
        // Neither verb was called: one write is enough to put a widget on screen and make it live.
        expect(label?.visible).toBe(true);
        expect(label?.enabled).toBe(true);
    });

    it('reaches the renderer as drawn art, and not only the state behind it', async () => {
        const { session, tab } = await open();
        expect(tab.score?.drawn).toBe('0');

        await press(session, tab, B.count);
        expect(drawn(tab, V.count)?.number).toBe(1);
        expect(tab.score?.drawn).toBe('1');

        // Twice, because a node created once from whatever the widget happened to say would also
        // have read '1' above.
        await press(session, tab, B.count);
        expect(tab.score?.drawn).toBe('2');
    });

    it('carries a fraction and an icon exactly as given, full or not', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.meter);
        expect(drawn(tab, V.meter)?.fraction).toBe(METER_FRACTION);

        // Nothing between the verb and the sink clamps, so a bar can be told to draw past full.
        await press(session, tab, B.overfill);
        expect(drawn(tab, V.meter)?.fraction).toBe(OVERFILL);

        await press(session, tab, B.badge);
        expect(drawn(tab, V.badge)?.icon).toBe(ASSET_DISC);
    });

    it('hides, shows, disables and enables without disturbing what it says', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.hide);
        expect(drawn(tab, V.label)?.visible).toBe(false);
        await press(session, tab, B.disable);
        expect(drawn(tab, V.label)?.enabled).toBe(false);
        // One record patched rather than replaced: the text outlived four writes never mentioning it.
        expect(says(tab, V.label)).toBe(LABEL_READY);

        await press(session, tab, B.show);
        await press(session, tab, B.enable);
        expect(drawn(tab, V.label)?.visible).toBe(true);
        expect(drawn(tab, V.label)?.enabled).toBe(true);
    });

    it('binds a countdown by reference, so the sink holds the object and not a reading of it', async () => {
        const { session, tab } = await open();
        // Read with no step behind it: this write never left the tab, and a tick of the mirror
        // would spend the very countdown the assertion is about.
        session.press(tab, B.clock, SCREEN_DECK);
        expect(drawn(tab, V.clock)?.countdown?.running).toBe(true);
        expect(drawn(tab, V.clock)?.countdown?.remaining).toBe(TIMER_SECONDS);

        // That handler calls no `hud` verb at all, so a sampled number could not have followed it.
        session.press(tab, B.retime, SCREEN_DECK);
        expect(drawn(tab, V.clock)?.countdown?.remaining).toBe(RETIMED_SECONDS);
        expect(runtimeOf(tab).log.records).toEqual([]);
    });
});

describe('a HUD screen', () => {
    it('runs the class it was handed before the open, on the open that follows it', async () => {
        const session = newSession(HUD_WORLD);
        const tab = await session.join('one');
        await session.live(tab);
        await session.step(SETTLE);

        // One open, and the deck's `@onStart` has already written its widget: `open` wires what the
        // screen holds at the moment it runs, so a class registered while it was closed is live on
        // the first frame anyone could look at it.
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK]);
        expect(says(tab, V.label)).toBe(LABEL_READY);
    });

    it('opens and closes the same way whether the HUD is asked or the screen is', async () => {
        const { session, tab } = await open();
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK]);

        await press(session, tab, B.openBag);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK, SCREEN_BAG]);
        expect(says(tab, V.greeting)).toBe(`${BAG_OPEN}:${SCREEN_BAG}`);

        await press(session, tab, B.closeBag);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK]);
        // `@onEnd` ran ahead of the teardown, so a screen says goodbye with its host still standing.
        expect(says(tab, V.greeting)).toBe(`${BAG_SHUT}:${SCREEN_BAG}`);

        // The same two transitions asked for from the screen instead of from the HUD.
        await press(session, tab, B.screenOpens);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK, SCREEN_BAG]);
        await press(session, tab, B.screenCloses);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK]);
    });

    it('discards its instances on close and builds fresh ones on the next open', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.openBag);
        expect(drawn(tab, V.presses)?.number).toBe(0);

        await press(session, tab, B.tally, SCREEN_BAG);
        await press(session, tab, B.tally, SCREEN_BAG);
        expect(drawn(tab, V.presses)?.number).toBe(2);

        await press(session, tab, B.closeBag);
        // A closed screen holds no instance, so the same press now reaches no handler at all.
        await press(session, tab, B.tally, SCREEN_BAG);
        expect(drawn(tab, V.presses)?.number).toBe(2);

        // The registration survives what the instance did not, so the reopen attaches the class
        // once more and its count starts over.
        await press(session, tab, B.openBag);
        expect(drawn(tab, V.presses)?.number).toBe(0);
    });

    it('answers a press only when the press names it', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.openBag);

        // One widget name with a handler for it on each open screen: only the screen the press
        // names answers, which is what keeps two menus with a `back` button apart.
        await press(session, tab, B.both, SCREEN_DECK);
        expect(says(tab, V.reached)).toBe(SCREEN_DECK);
        await press(session, tab, B.both, SCREEN_BAG);
        expect(says(tab, V.reached)).toBe(SCREEN_BAG);

        // A press naming no screen reaches every other kind of host and no screen whatever.
        session.press(tab, B.both);
        await session.step(SETTLE);
        expect(says(tab, V.reached)).toBe(SCREEN_BAG);
    });

    it('is listed once minted and stays listed after it closes', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.openBag);
        await press(session, tab, B.report);
        expect(says(tab, V.screens)).toBe(`${SCREEN_BAG} ${SCREEN_DECK}`);
        // Open order rather than name order, which is the whole difference between the two lists.
        expect(says(tab, V.open)).toBe(`${SCREEN_DECK} ${SCREEN_BAG}`);

        await press(session, tab, B.closeBag);
        await press(session, tab, B.report);
        expect(says(tab, V.screens)).toBe(`${SCREEN_BAG} ${SCREEN_DECK}`);
        expect(says(tab, V.open)).toBe(SCREEN_DECK);
    });

    it('goes down with every other open screen when the HUD closes them all', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.openBag);
        await press(session, tab, B.closeAll);
        expect(tab.client.hud.openScreens).toEqual([]);

        // The deck closed itself out from under the handler that asked, so nothing answers now.
        await press(session, tab, B.count);
        expect(drawn(tab, V.count)?.number).toBe(0);
    });
});

describe('what the HUD answers about itself', () => {
    it("names the tab's own player, and not whoever the roster holds first", async () => {
        const session = newSession(HUD_WORLD);
        const one = await session.join('one');
        const two = await session.join('two');
        await session.live(one, two);
        await session.step(SETTLE);

        await press(session, one, B.report);
        await press(session, two, B.report);
        expect(says(one, V.player)).toBe(one.client.localPlayer?.id);
        expect(says(two, V.player)).toBe(two.client.localPlayer?.id);
        expect(says(one, V.player)).not.toBe(says(two, V.player));
    });

    it('finds a screen by name whether it is open or not, and nothing by any other', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.report);
        // Closed, still registered, still there: a close discards a screen's instances, not the
        // screen or the classes it was given.
        expect(says(tab, V.bag)).toBe(`${SCREEN_BAG}:false:1|${NONE}`);

        await press(session, tab, B.openBag);
        await press(session, tab, B.report);
        expect(says(tab, V.bag)).toBe(`${SCREEN_BAG}:true:1|${NONE}`);
    });

    it('reads a widget back as authored, and answers nothing for a name never written', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.hide);
        await press(session, tab, B.report);

        const held = drawn(tab, V.label);
        // The record core authored and the copy the sink handed the UI say the same thing.
        expect(says(tab, V.echo)).toBe(`${LABEL_READY}:false:true|${NONE}`);
        expect(`${held?.text}:${held?.visible}:${held?.enabled}`).toBe(`${LABEL_READY}:false:true`);
        expect(drawn(tab, NOTHING)).toBeNull();
    });
});

describe('a screen whose flag was moved behind the HUD', () => {
    it('can never be closed again, and stays open on the client that drew it', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.openBag);
        await press(session, tab, B.unlist);
        await press(session, tab, B.report);

        // `setVisible` writes the flag and nothing else: the HUD's open list and the client's both
        // still carry the bag, and `close` reads that same flag to decide it has nothing to do.
        expect(says(tab, V.bag)).toBe(`${SCREEN_BAG}:false:1|${NONE}`);
        expect(says(tab, V.open)).toBe(`${SCREEN_DECK} ${SCREEN_BAG}`);

        await press(session, tab, B.closeBag);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK, SCREEN_BAG]);

        // `closeAll` walks that same list through that same `close`, so the bag outlives it.
        await press(session, tab, B.closeAll);
        expect(tab.client.hud.openScreens).toEqual([SCREEN_BAG]);
    });

    it('can never be opened either, so the class it holds never runs', async () => {
        const { session, tab } = await open();
        await press(session, tab, B.relist);
        await press(session, tab, B.openBag);

        // `open` returns on the same flag before it wires anything, so no instance exists and the
        // screen reaches no client.
        expect(drawn(tab, V.greeting)).toBeNull();
        expect(tab.client.hud.openScreens).toEqual([SCREEN_DECK]);

        await press(session, tab, B.tally, SCREEN_BAG);
        expect(drawn(tab, V.presses)).toBeNull();
    });
});

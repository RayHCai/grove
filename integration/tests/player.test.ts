// The `Player` facade, driven through a game and read back off a client.
//
// A body is handed out by a press rather than by the join, so every roster verb is reached on its
// own and the tab is watched across each transition. The cursor and the binding table a player
// carries are stubs on both ends, so what those cases pin is how far a write to one travels — and
// the answer, asserted on the wire rather than argued from the source, is no further than the
// object written to.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { avatarOf, gameField, mineField, newSession, runtimeOf, transformIn } from './harness.js';
import {
    CODE_AIM,
    CODE_SPARE,
    CODE_STEP,
    CODE_STRANGE,
    PLAYER_WORLD,
    RENAMED,
    S,
    SPAWN_AT,
    STATE_STEPS,
    TELEPORT_AT,
    W,
} from '../dist/worlds/player.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
/** Ticks that outlast the lead a client sends input at, plus the interval it is answered in. */
const KEY_TICKS = 40;

/** What the two actions are bound to on the authority once `bind` has run. */
const REBOUND = `${CODE_STRANGE} ${CODE_SPARE}/${CODE_AIM}`;

async function open(name = 'ada'): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(PLAYER_WORLD);
    const tab = await session.join(name);
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

/** What one tab's roster calls a player — the only place a name reaches a peer at all. */
function rosterName(tab: Tab, playerId: string): string | undefined {
    return runtimeOf(tab).playerManager.byId(playerId)?.name;
}

describe('a player who is handed a body', () => {
    it("has none until the game hands one out, which arrives at the roster's default point", async () => {
        const { session, tab } = await open();
        await press(session, tab, W.look);
        expect(reading<boolean>(tab, S.bodied)).toBe(false);
        // The throwing getter, asked on the authority: `hasAvatar` is the question that answers.
        expect(reading<boolean>(tab, S.bodiless)).toBe(true);
        expect(avatarOf(tab)).toBeUndefined();

        await press(session, tab, W.spawn);
        expect(reading<boolean>(tab, S.bodied)).toBe(true);
        expect(reading<boolean>(tab, S.bodiless)).toBe(false);
        const at = drawn(tab);
        expect(at.x).toBeCloseTo(SPAWN_AT.x, 5);
        expect(at.y).toBeCloseTo(SPAWN_AT.y, 5);
    });

    it('teleports the body it owns, and does nothing at all without one', async () => {
        const { session, tab } = await open();
        // Bodiless, where `teleportTo` has nothing to move: it declines rather than throwing.
        await press(session, tab, W.teleport);
        expect(session.trips).toEqual([]);
        expect(avatarOf(tab)).toBeUndefined();

        await press(session, tab, W.spawn);
        await press(session, tab, W.teleport);
        const at = drawn(tab);
        expect(at.x).toBeCloseTo(TELEPORT_AT.x, 5);
        expect(at.y).toBeCloseTo(TELEPORT_AT.y, 5);
    });

    it('spectates by destroying the body, which the tab is told about like any other destroy', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spawn);
        expect(avatarOf(tab)).toBeDefined();

        await press(session, tab, W.spectate);
        expect(reading<boolean>(tab, S.bodied)).toBe(false);
        expect(reading<boolean>(tab, S.bodiless)).toBe(true);
        expect(avatarOf(tab)).toBeUndefined();
    });

    it('respawns as a new body at the spawn point rather than walking the old one back', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spawn);
        await press(session, tab, W.teleport);
        const first = mine(tab);

        await press(session, tab, W.respawn);
        // A fresh handle, not the same slot moved: the roster destroys before it instantiates, and
        // an id carries the generation it was minted in.
        expect(mine(tab)).not.toBe(first);
        expect(drawn(tab).x).toBeCloseTo(SPAWN_AT.x, 5);
        expect(reading<boolean>(tab, S.bodied)).toBe(true);
    });

    it('can be parted from a body that goes on existing, which no tab is ever told', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spawn);
        const body = mine(tab);

        await press(session, tab, W.disown);
        expect(reading<boolean>(tab, S.bodied)).toBe(false);
        expect(reading<boolean>(tab, S.bodiless)).toBe(true);
        // `setAvatar` re-points one field on the authority's own Player and journals nothing, so
        // this tab still holds a live body owned by a player the server believes has none.
        expect(avatarOf(tab)).toBe(body);

        // The one observable difference: a verb that needs the avatar now finds none.
        await press(session, tab, W.teleport);
        expect(drawn(tab).x).toBeCloseTo(SPAWN_AT.x, 5);

        await press(session, tab, W.reclaim);
        expect(reading<boolean>(tab, S.bodied)).toBe(true);
        await press(session, tab, W.teleport);
        expect(drawn(tab).x).toBeCloseTo(TELEPORT_AT.x, 5);
    });
});

describe('the roster a tab is told about', () => {
    it('numbers each seat once, and hands every tab the number the authority holds', async () => {
        const session = newSession(PLAYER_WORLD);
        const one = await session.join('ada');
        const two = await session.join('brin');
        await session.live(one, two);
        await session.step(SETTLE);

        await press(session, one, W.identify);
        expect(reading<number>(one, S.seat)).toBe(0);
        expect(reading<string>(one, S.who)).toBe('ada');

        await press(session, two, W.identify);
        expect(reading<number>(two, S.seat)).toBe(1);
        expect(reading<string>(two, S.who)).toBe('brin');

        // The index rides the join op, so a roster a tab minted for itself agrees with the
        // authority's rather than being renumbered from the order that tab heard about people in.
        expect(one.client.localPlayer?.index).toBe(0);
        expect(two.client.localPlayer?.index).toBe(1);
        expect(one.client.localPlayer?.name).toBe('ada');
    });

    it('renames on the authority alone, so only a tab that joins afterwards sees the new name', async () => {
        const session = newSession(PLAYER_WORLD);
        const one = await session.join('ada');
        await session.live(one);
        await session.step(SETTLE);

        await press(session, one, W.rename);
        expect(reading<string>(one, S.who)).toBe(RENAMED);
        // A name crosses the wire on the join op and in a joiner's snapshot, and by no third
        // route — there is no rename op, so the renamed player's own tab is the one never told.
        expect(one.client.localPlayer?.name).toBe('ada');

        const two = await session.join('brin');
        await session.live(two);
        await session.step(SETTLE);
        // A joiner's snapshot is a walk of LIVE state, which is where the new name is.
        expect(rosterName(two, one.client.localPlayer?.id ?? '')).toBe(RENAMED);
    });
});

describe("a player's own store", () => {
    it('keeps what each of them put under one key, and forgets only the one asking', async () => {
        const session = newSession(PLAYER_WORLD);
        const one = await session.join('ada');
        const two = await session.join('brin');
        await session.live(one, two);
        await session.step(SETTLE);

        await press(session, one, W.remember);
        expect(reading<string>(one, S.stored)).toBe('ada');
        await press(session, two, W.remember);
        expect(reading<string>(two, S.stored)).toBe('brin');

        // One key, two scopes: a `Storage` is keyed by the player it was read off.
        await press(session, one, W.recall);
        expect(reading<string>(one, S.stored)).toBe('ada');

        await press(session, one, W.forget);
        expect(reading<string>(one, S.stored)).toBe('');
        await press(session, two, W.recall);
        expect(reading<string>(two, S.stored)).toBe('brin');
    });
});

describe('the cursor a player carries', () => {
    it('reads as an origin over nothing, while that same tab points at a body', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spawn, SETTLE * 2);
        const body = mine(tab);
        const at = drawn(tab);
        // A real hover, resolved against what is DRAWN — the path a click takes to an entity.
        expect(session.hover(tab, { x: at.x, y: at.y })).toBe(body);

        await press(session, tab, W.readCursor);
        // Nothing carries pointer state to the authority: this object is a stub on both ends, and
        // a hit reaches creator code through `@onClick` and the client's own binding table.
        expect(reading<string>(tab, S.pointer)).toBe('0,0,0|0,0,0|nothing|false');
        expect(tab.client.localPlayer?.cursor.over).toBeNull();
        expect(tab.client.localPlayer?.cursor.isDown).toBe(false);
    });

    it('takes an icon, a lock and a hiding without faulting, and tells no tab about any of it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.hideCursor);
        // Written after the icon, the lock and the unlock, so one of those throwing would leave
        // this at the value it was declared with.
        expect(reading<boolean>(tab, S.shown)).toBe(false);
        expect(session.trips).toEqual([]);
        // The write stopped at the authority's own object: this tab holds a different stub, and no
        // channel was marked for the one that changed.
        expect(tab.client.localPlayer?.cursor.visible).toBe(true);
    });
});

describe('the binding table a player carries', () => {
    it('remembers a rebind, appends to it, and hands back a list nobody can bind through', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.bind);
        expect(reading<string>(tab, S.keys)).toBe(REBOUND);
        expect(reading<boolean>(tab, S.copies)).toBe(true);
    });

    it('clears one action by name and every action when given none', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.bind);

        await press(session, tab, W.clearOne);
        expect(reading<string>(tab, S.keys)).toBe(`/${CODE_AIM}`);

        await press(session, tab, W.clearAll);
        expect(reading<string>(tab, S.keys)).toBe('/');
    });

    it("takes a context that changes nothing, the device that would honour one being the tab's", async () => {
        const { session, tab } = await open();
        await press(session, tab, W.bind);
        await press(session, tab, W.context);
        expect(reading<string>(tab, S.keys)).toBe(REBOUND);
    });

    it('rebinds no key a person can press, the tab resolving codes through its own table', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.spawn);
        session.tap(tab, CODE_STEP);
        await session.step(KEY_TICKS);
        expect(mineField<number>(tab, STATE_STEPS)).toBe(1);

        await press(session, tab, W.bind);
        // `step` names those two codes on the authority now. The client was never told, and it is
        // the client that turns a code into the action an input frame carries.
        session.tap(tab, CODE_STRANGE);
        session.tap(tab, CODE_SPARE);
        await session.step(KEY_TICKS);
        expect(mineField<number>(tab, STATE_STEPS)).toBe(1);

        session.tap(tab, CODE_STEP);
        await session.step(KEY_TICKS);
        expect(mineField<number>(tab, STATE_STEPS)).toBe(2);
    });
});

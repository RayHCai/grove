// Every event and lifecycle decorator, fired the way a player fires one and read back off a client.
//
// Each case reaches its handler through the edge that really raises it — a key through the binding
// table and an input frame, a pointer through the pick path, a crossing through the region pass —
// because a decorator only earns its place if the engine dispatches at the host it was declared on.
// The counters are replicated, so a handler that ran and marked nothing fails here.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { gameField, mineField, newSession, ofTemplate, runtimeOf, transformIn } from './harness.js';
import { SEND_RATE, SIM_RATE } from '../dist/world.js';
import {
    ACTION_PULSE,
    CODE_GATE,
    CODE_PULSE,
    EVENTS_WORLD,
    GATE_SECONDS,
    GRANT_AMOUNT,
    P,
    S,
    SCREEN_KIOSK,
    TEMPLATE_BEACON,
    W,
    WIDGET_ASK,
} from '../dist/worlds/events.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
/** Ticks between broadcasts, which is what bounds how stale a tab's reading of a live counter is. */
const SEND_INTERVAL = SIM_RATE / SEND_RATE;
/** Ticks that outlast the parked gate handlers, whatever the send rate rounds them to. */
const GATE_TICKS = Math.ceil(GATE_SECONDS * SIM_RATE) + SETTLE * 3;
/** Taps in the burst the three concurrency modes are told apart by. */
const GATE_TAPS = 3;
/**
 * Ticks between those taps.
 *
 * More than one, because a frame that advanced no tick holds its edges back — and the next flush
 * coalesces one entry per (action, phase), which would turn two taps into one press.
 */
const GATE_GAP = 3;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(EVENTS_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string): Promise<void> {
    session.press(tab, widget);
    await session.step(SETTLE);
}

/** A Game-hosted reading, as this tab holds it. */
function reading<T>(tab: Tab, field: string): T | undefined {
    return gameField<T>(runtimeOf(tab), field);
}

/** The beacon where this tab draws it, so a pick runs against art rather than against the simulation. */
function beaconPoint(tab: Tab): { x: number; y: number } {
    const rt = runtimeOf(tab);
    const beacon = ofTemplate(rt, TEMPLATE_BEACON)[0];
    if (beacon === undefined) throw new Error('no beacon in the mirror');
    const at = transformIn(rt, beacon);
    return { x: at.x, y: at.y };
}

function landed(hit: EntityId | undefined): EntityId {
    if (hit === undefined) throw new Error('the pointer resolved to nothing drawn');
    return hit;
}

describe('a world coming up and a player going away', () => {
    it('starts the Game once and each body it later mints once', async () => {
        const session = newSession(EVENTS_WORLD);
        const one = await session.join('one');
        await session.live(one);
        await session.step(SETTLE);
        expect(reading<number>(one, S.starts)).toBe(1);
        expect(reading<number>(one, S.equips)).toBe(1);

        const two = await session.join('two');
        await session.live(two);
        await session.step(SETTLE);
        // A joiner brings a body and its `@onStart`, and does not re-run the world's.
        expect(reading<number>(two, S.starts)).toBe(1);
        expect(reading<number>(two, S.equips)).toBe(2);
        expect(reading<number>(one, S.equips)).toBe(2);
    });

    it("ends a leaver's own scripts, and a tab that stayed is told of it", async () => {
        const session = newSession(EVENTS_WORLD);
        const one = await session.join('one');
        const two = await session.join('two');
        await session.live(one, two);
        await session.step(SETTLE);
        expect(reading<number>(two, S.ends)).toBe(0);

        session.leave(one);
        await session.step(SETTLE * 4);
        expect(reading<number>(two, S.ends)).toBe(1);
        expect(session.trips).toEqual([]);
    });
});

describe('the update pass', () => {
    it('runs a server handler once per tick, and the tab is told every tick of it', async () => {
        const { session, tab } = await open();
        const rt = session.server.runtime;
        const fromTick = rt.tick;
        const fromServer = gameField<number>(rt, S.ticks) ?? 0;
        const fromMirror = reading<number>(tab, S.ticks) ?? 0;

        await session.step(SIM_RATE);

        // Against the tick counter rather than against the number of pumps: the driver owns the
        // accumulator, and the claim here is one dispatch per tick, not one tick per wake.
        const ticked = rt.tick - fromTick;
        expect(ticked).toBeGreaterThan(45);
        expect((gameField<number>(rt, S.ticks) ?? 0) - fromServer).toBe(ticked);

        const toMirror = reading<number>(tab, S.ticks) ?? 0;
        expect(toMirror).toBeGreaterThan(fromMirror + 45);
        // A field rewritten every tick still leaves on the send interval, so the tab trails by one
        // of those plus the pump that carries it — never by the whole run.
        expect((gameField<number>(rt, S.ticks) ?? 0) - toMirror).toBeLessThanOrEqual(
            SEND_INTERVAL * 2,
        );
    });
});

describe('a bound key', () => {
    it('raises the release on the way up and never on the way down', async () => {
        const { session, tab } = await open();

        session.hold(tab, CODE_PULSE);
        await session.step(SETTLE);
        expect(mineField<number>(tab, P.presses)).toBe(1);
        // Nothing has let go, so a release handler that fired here is one firing on the press edge.
        expect(mineField<number>(tab, P.releases)).toBe(0);

        session.release(tab, CODE_PULSE);
        await session.step(SETTLE);
        expect(mineField<number>(tab, P.releases)).toBe(1);
        expect(mineField<number>(tab, P.presses)).toBe(1);

        // Once, not once per tick of the frames that followed it.
        await session.step(SETTLE * 2);
        expect(mineField<number>(tab, P.releases)).toBe(1);
    });

    it('holds every tick between the two edges and stops on the release', async () => {
        const { session, tab } = await open();
        session.hold(tab, CODE_PULSE);
        await session.step(SETTLE);
        const early = mineField<number>(tab, P.holds) ?? 0;
        expect(early).toBeGreaterThan(0);

        await session.step(SETTLE);
        expect(mineField<number>(tab, P.holds) ?? 0).toBeGreaterThan(early);

        session.release(tab, CODE_PULSE);
        await session.step(SETTLE * 2);
        const settled = mineField<number>(tab, P.holds) ?? 0;
        await session.step(SETTLE * 2);
        expect(mineField<number>(tab, P.holds)).toBe(settled);
    });

    it('folds into the action state the tab predicts from, edge for edge', async () => {
        const { session, tab } = await open();
        // The same fold the authority runs on its own connection: a divergence here is not a wrong
        // reading, it is a prediction mismatch.
        expect(tab.client.actions.held(ACTION_PULSE)).toBe(false);
        expect(tab.client.actions.axis(ACTION_PULSE)).toBe(0);

        session.hold(tab, CODE_PULSE);
        await session.step(SETTLE);
        expect(tab.client.actions.held(ACTION_PULSE)).toBe(true);
        // A bound button reads as a full axis, so a movement type filling intent from one works.
        expect(tab.client.actions.axis(ACTION_PULSE)).toBe(1);
        expect(tab.client.actions.heldActions()).toContain(ACTION_PULSE);

        session.release(tab, CODE_PULSE);
        await session.step(SETTLE);
        expect(tab.client.actions.held(ACTION_PULSE)).toBe(false);
        expect(tab.client.actions.axis(ACTION_PULSE)).toBe(0);
        // One tick wide, and many ticks have passed since the edge that raised it.
        expect(tab.client.actions.released(ACTION_PULSE)).toBe(false);
    });

    it('delivers both edges of a tap that opened and closed in one frame, and no hold', async () => {
        const { session, tab } = await open();
        session.tap(tab, CODE_PULSE);
        await session.step(SETTLE * 2);

        expect(mineField<number>(tab, P.presses)).toBe(1);
        expect(mineField<number>(tab, P.releases)).toBe(1);
        // A hold is synthesized from the authority's own fold, and the action left it on the tick it
        // entered — so there was never a tick on which it was down.
        expect(mineField<number>(tab, P.holds)).toBe(0);
    });
});

describe('a pointer over drawn art', () => {
    it('raises the two hover edges without ever raising a click', async () => {
        const { session, tab } = await open();
        const beacon = landed(session.hover(tab, beaconPoint(tab)));
        await session.step(SETTLE);
        expect(reading<number>(tab, S.hoverIns)).toBe(1);
        expect(reading<number>(tab, S.hoverOuts)).toBe(0);
        expect(reading<number>(tab, S.clicks)).toBe(0);

        session.unhover(tab, beacon);
        await session.step(SETTLE);
        expect(reading<number>(tab, S.hoverOuts)).toBe(1);
        expect(reading<number>(tab, S.clicks)).toBe(0);
    });

    it('raises a click at the entity behind the node it hit, between both hover edges', async () => {
        const { session, tab } = await open();
        const hit = landed(session.click(tab, beaconPoint(tab)));
        await session.step(SETTLE);

        expect(hit).toBe(ofTemplate(runtimeOf(tab), TEMPLATE_BEACON)[0]);
        expect(reading<number>(tab, S.clicks)).toBe(1);
        // The canvas raises enter and exit around one press, and all three cross to the authority.
        expect(reading<number>(tab, S.hoverIns)).toBe(1);
        expect(reading<number>(tab, S.hoverOuts)).toBe(1);
    });
});

describe('two bodies and a named rectangle', () => {
    it('reports the overlap on the tick it begins and not again while it lasts', async () => {
        const { session, tab } = await open();
        expect(reading<number>(tab, S.bumps)).toBe(0);

        await press(session, tab, W.toBeacon);
        expect(reading<number>(tab, S.bumps)).toBe(1);

        // Still standing on it: `@onCollide` is the moment two bodies touch, not a per-tick predicate.
        await session.step(SETTLE * 3);
        expect(reading<number>(tab, S.bumps)).toBe(1);
    });

    it('reports a region entry, then the exit that leaving it produces', async () => {
        const { session, tab } = await open();
        expect(reading<number>(tab, S.entries)).toBe(0);

        await press(session, tab, W.toPit);
        expect(reading<number>(tab, S.entries)).toBe(1);
        expect(reading<number>(tab, S.exits)).toBe(0);

        await press(session, tab, W.toHome);
        expect(reading<number>(tab, S.exits)).toBe(1);
        // The teleport home is not a second arrival: the fold is a diff, not a re-test.
        expect(reading<number>(tab, S.entries)).toBe(1);
    });
});

describe('a widget press', () => {
    it('reaches a Game handler carrying the player the connection names', async () => {
        const { session, tab } = await open();
        const me = tab.client.localPlayer?.id;
        expect(me).toBeDefined();
        expect(reading<string>(tab, S.presser)).toBe('');

        await press(session, tab, W.mark);
        expect(reading<string>(tab, S.presser)).toBe(me);
    });
});

describe('a request raised from a client script', () => {
    it('crosses the wire and reaches the server handler with its payload and its asker', async () => {
        const { session, tab } = await open();
        const me = tab.client.localPlayer?.id;
        expect(reading<number>(tab, S.grants)).toBe(0);

        // Pressed on the kiosk screen, so the client-located handler that calls `request()` is the
        // only thing that runs here — this world's `@onRequest` lives on the authority, where no
        // press of this widget is dispatched.
        session.press(tab, WIDGET_ASK, SCREEN_KIOSK);
        await session.step(SETTLE);

        // Read off the MIRROR: the count only gets here by the authority having answered the ask
        // and replicated the result back.
        expect(reading<number>(tab, S.grants)).toBe(GRANT_AMOUNT);
        // Engine-supplied from the connection: the frame carries a name and an amount and no claim
        // about who sent it.
        expect(reading<string>(tab, S.asker)).toBe(me);

        session.press(tab, WIDGET_ASK, SCREEN_KIOSK);
        await session.step(SETTLE);
        expect(reading<number>(tab, S.grants)).toBe(GRANT_AMOUNT * 2);
        expect(session.trips).toEqual([]);
    });

    it('answers one raised on the authority too, where the sink is already local', async () => {
        const { session, tab } = await open();
        // The same ask with no wire under it, so a failure here is the handler and a failure above
        // is the channel.
        session.press(tab, W.relay);
        await session.step(SETTLE);

        expect(reading<number>(tab, S.grants)).toBe(GRANT_AMOUNT);
        expect(reading<string>(tab, S.asker)).toBe(tab.client.localPlayer?.id);
    });
});

describe('three handlers on one action, one per concurrency mode', () => {
    it('admits a re-entry under restart and concurrent, and drops it under ignore', async () => {
        const { session, tab } = await open();
        for (let i = 0; i < GATE_TAPS; i++) {
            session.tap(tab, CODE_GATE);
            await session.step(GATE_GAP);
        }
        await session.step(SETTLE);

        // Every tap lands while the first invocation is still parked, which is the only window in
        // which the three modes differ at all.
        expect(mineField<number>(tab, P.ignoreIn)).toBe(1);
        expect(mineField<number>(tab, P.restartIn)).toBe(GATE_TAPS);
        expect(mineField<number>(tab, P.manyIn)).toBe(GATE_TAPS);
    });

    it('finishes the invocation restart replaced, since cancelling frees only a lock', async () => {
        const { session, tab } = await open();
        for (let i = 0; i < GATE_TAPS; i++) {
            session.tap(tab, CODE_GATE);
            await session.step(GATE_GAP);
        }
        await session.step(GATE_TICKS);

        expect(mineField<number>(tab, P.ignoreOut)).toBe(1);
        expect(mineField<number>(tab, P.manyOut)).toBe(GATE_TAPS);
        // Not one: `InvocationScope.cancel` is declared and never assigned anywhere in the engine,
        // so a restarted handler's `await sleep(...)` still resolves and its body still runs to the
        // end. Restart re-arms the slot; it does not unwind the call it took the slot from.
        expect(mineField<number>(tab, P.restartOut)).toBe(GATE_TAPS);
        expect(session.trips).toEqual([]);
    });
});

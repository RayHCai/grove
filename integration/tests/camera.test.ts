// The `Camera` API, driven through a game and read off the thing that draws it.
//
// A camera reaches no wire: its state is not in the transform store, no snapshot carries it and no
// write marks a channel. So the reading that matters here is the `CameraState` the tab pushes at
// its renderer every frame, and the second reading is a HUD widget the camera's own script wrote —
// both on the machine the camera belongs to. Half of this surface turns out to reach nothing at
// all, and each case that pins one says which sink swallowed it.

import { describe, expect, it } from 'vitest';
import type { Camera, Runtime } from '@platform/core';
import type { CameraState } from '@platform/renderer';
import type { Session, Tab } from './harness.js';
import { newSession, runtimeOf } from './harness.js';
import {
    AVATAR_AT,
    CAMERA_WORLD,
    FENCE,
    GLIDE_TO,
    NONE,
    PAN_TO,
    TARGET_ENTITY,
    TARGET_PLAYER,
    TWEEN_SECONDS,
    VIEW_HALF,
    W,
    WIDGET,
    ZOOM_TO,
} from '../dist/worlds/camera.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;
/** Ticks that outlast the seconds every camera tween below was handed. */
const TWEEN_TICKS = Math.ceil(TWEEN_SECONDS * 60) + SETTLE;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(CAMERA_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

/** A tab whose camera has been given a lens — what every case below but the first needs. */
async function fitted(): Promise<{ session: Session; tab: Tab }> {
    const opened = await open();
    await press(opened.session, opened.tab, W.mount);
    return opened;
}

/** Two tabs on one world, so a per-player claim has a second camera to be wrong about. */
async function pair(): Promise<{ session: Session; one: Tab; two: Tab }> {
    const session = newSession(CAMERA_WORLD);
    const one = await session.join('one');
    const two = await session.join('two');
    await session.live(one, two);
    await session.step(SETTLE);
    return { session, one, two };
}

/** What this tab last told its renderer to draw from. */
function drawn(tab: Tab): Readonly<CameraState> {
    return tab.renderer.camera;
}

function shown(tab: Tab, widget: string): string | undefined {
    return tab.client.hud.widgetOf(widget)?.text;
}

function counted(tab: Tab, widget: string): number | undefined {
    return tab.client.hud.widgetOf(widget)?.number;
}

/** A widget the lens wrote as a row of numbers, parsed back. */
function numbers(tab: Tab, widget: string): number[] {
    const text = shown(tab, widget);
    return text === undefined ? [] : text.split('|').map(Number);
}

/** How wide a world the renderer says it is showing, which zoom is the only input to. */
function shownWidth(tab: Tab): number {
    const view = tab.renderer.viewport;
    return view.right - view.left;
}

function idOf(tab: Tab): string {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) throw new Error(`${tab.name} has no player yet`);
    return id;
}

/** One player's camera in whichever world is asked — a mirror's or the authority's. */
function cameraIn(rt: Runtime, playerId: string): Camera {
    const player = rt.playerManager.byId(playerId);
    if (player === null) throw new Error(`no player ${playerId} in this world`);
    return player.camera;
}

describe('a camera reached from the game', () => {
    it('answers no camera verb until a script has been added to it', async () => {
        const { session, tab } = await open();
        await press(session, tab, W.read);
        // Nothing is hosted there yet, so the press reaches no handler and writes no widget.
        expect(tab.client.hud.widgetOf(WIDGET.spot)).toBeNull();

        await press(session, tab, W.mount);
        await press(session, tab, W.read);
        expect(numbers(tab, WIDGET.spot)).toEqual([0, 0, 0]);
    });

    it('is one object, however many times the player is asked for it', async () => {
        const { session, tab } = await fitted();
        expect(drawn(tab).position.x).toBe(0);

        await press(session, tab, W.pan);
        // Three separate reads of `player.camera` have to have landed on the same object: the one
        // the lens was mounted on, the one the pan wrote, and the one the frame draws from.
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
        expect(drawn(tab).position.y).toBe(PAN_TO.y);
        await press(session, tab, W.read);
        expect(numbers(tab, WIDGET.spot)).toEqual([PAN_TO.x, PAN_TO.y, 0]);
    });

    it('belongs to one player: a second tab goes on drawing its own', async () => {
        const { session, one, two } = await pair();
        await press(session, one, W.pan);
        expect(drawn(one).position.x).toBe(PAN_TO.x);
        expect(drawn(two).position.x).toBe(0);
        expect(drawn(two).position.y).toBe(0);
    });
});

describe("a camera's point", () => {
    it('moves to an absolute place rather than by a step', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);
        await press(session, tab, W.pan);
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
    });

    it('glides by cutting, so the destination is drawn on the very next frame', async () => {
        const { session, tab } = await fitted();
        session.press(tab, W.glideTo);
        await session.step(1);
        // A camera on the tween engine would be a fraction of the way there after one frame; this
        // one takes the seconds it was handed and drops them.
        expect(drawn(tab).position.x).toBe(GLIDE_TO.x);
        expect(drawn(tab).position.y).toBe(GLIDE_TO.y);

        await session.step(TWEEN_TICKS);
        expect(drawn(tab).position.x).toBe(GLIDE_TO.x);
    });
});

describe("a camera's zoom", () => {
    it('zooms by cutting too, and the renderer narrows the world it shows', async () => {
        const { session, tab } = await fitted();
        const wide = shownWidth(tab);

        session.press(tab, W.zoomTo);
        await session.step(1);
        expect(drawn(tab).zoom).toBe(ZOOM_TO);
        expect(shownWidth(tab)).toBeCloseTo(wide / ZOOM_TO, 6);

        await press(session, tab, W.read);
        expect(counted(tab, WIDGET.zoom)).toBe(ZOOM_TO);
        // The same reading off the renderer's text node: a widget a camera script wrote reaches art.
        expect(tab.score?.drawn).toBe(String(ZOOM_TO));
    });
});

describe('what a camera follows', () => {
    it('draws from where its target IS, leaving its own point where it was', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);
        await press(session, tab, W.follow);

        expect(drawn(tab).position.x).toBeCloseTo(AVATAR_AT.x, 3);
        expect(drawn(tab).position.y).toBeCloseTo(AVATAR_AT.y, 3);
        await press(session, tab, W.read);
        expect(shown(tab, WIDGET.target)).toBe(TARGET_ENTITY);
        // Following overrides what is drawn; it does not move the camera it is following with.
        expect(numbers(tab, WIDGET.spot)).toEqual([PAN_TO.x, PAN_TO.y, 0]);
    });

    it('takes a player as a target, holds it, and then resolves it nowhere', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);
        await press(session, tab, W.followSelf);
        await press(session, tab, W.read);

        expect(shown(tab, WIDGET.target)).toBe(TARGET_PLAYER);
        // Stored and reported, and read by nothing: the frame only resolves a target with an entity
        // behind it, so a player target falls through to the camera's own point.
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
    });

    it('lets go of a target when it is told to follow nothing', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);
        await press(session, tab, W.follow);
        expect(drawn(tab).position.x).toBeCloseTo(AVATAR_AT.x, 3);

        await press(session, tab, W.unfollow);
        await press(session, tab, W.read);
        expect(shown(tab, WIDGET.target)).toBe(NONE);
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
    });
});

describe('the camera surface that reaches nothing', () => {
    it('keeps the bounds it is given and then travels straight through them', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.read);
        expect(shown(tab, WIDGET.fence)).toBe(NONE);

        await press(session, tab, W.fence);
        await press(session, tab, W.read);
        expect(numbers(tab, WIDGET.fence)).toEqual([
            FENCE.left,
            FENCE.right,
            FENCE.top,
            FENCE.bottom,
        ]);

        await press(session, tab, W.pan);
        // `PAN_TO` is outside the fence on both axes and the camera goes there anyway: `bounds` is
        // stored and read back, and neither end clamps a camera to it.
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
        expect(drawn(tab).position.y).toBe(PAN_TO.y);
    });

    it('reports a fixed window around itself that no zoom narrows', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);
        await press(session, tab, W.read);
        const box = [
            PAN_TO.x - VIEW_HALF.w,
            PAN_TO.x + VIEW_HALF.w,
            PAN_TO.y + VIEW_HALF.h,
            PAN_TO.y - VIEW_HALF.h,
        ];
        expect(numbers(tab, WIDGET.view)).toEqual(box);

        await press(session, tab, W.zoomTo);
        await press(session, tab, W.read);
        // Unchanged, while the renderer's own world rect halved: `Camera.viewport` is a fixed
        // 800x600 placeholder that cannot see the window it stands in for.
        expect(numbers(tab, WIDGET.view)).toEqual(box);
        expect(shownWidth(tab)).toBeCloseTo((VIEW_HALF.w * 2) / ZOOM_TO, 6);
    });

    it('shakes into a sink no client installs, and answers with the camera anyway', async () => {
        const { session, tab } = await fitted();
        await press(session, tab, W.pan);

        await press(session, tab, W.shake);
        await press(session, tab, W.shake);
        // Core plays `camera.shake` on the runtime's `EffectSink` and neither endpoint replaces the
        // null one it boots with, so the chained return is all a caller can observe of the call.
        expect(counted(tab, WIDGET.shakes)).toBe(2);
        expect(drawn(tab).position.x).toBe(PAN_TO.x);
        expect(drawn(tab).position.y).toBe(PAN_TO.y);
        expect(session.trips).toEqual([]);
    });
});

describe("the authority's own copy of a camera", () => {
    it('moves when the same handler runs there, and reaches no tab at all', async () => {
        const { session, one, two } = await pair();
        const mine = idOf(one);

        await press(session, one, W.pan);
        // The synced handler runs on both ends, so the authority holds a moved camera for this
        // player...
        expect(cameraIn(session.sim.runtime, mine).position.x).toBe(PAN_TO.x);
        // ...and the other tab, which holds the same player, has one still at the origin. Camera
        // state is in no snapshot and on no channel; each end computes its own or has none.
        expect(cameraIn(runtimeOf(two), mine).position.x).toBe(0);
        expect(cameraIn(runtimeOf(two), mine).zoom).toBe(1);
    });
});

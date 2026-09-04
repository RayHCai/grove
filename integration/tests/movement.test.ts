// The built-in movement types, driven by held keys and read back off a client.
//
// Movement is the one pass both endpoints are supposed to replay, so every case here installs a
// movement type through `setMovement`, drives it from a bound key, and asserts on what the TAB was
// told about its own body. Two claims below are the opposite of the design: a client builds the
// movement instance the wire names and never ticks it, and a platformer on the shipped physics sink
// neither lands nor jumps.

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@platform/core';
import { BREAKER_THRESHOLD, entityKey } from '@platform/core';
import type { Session, Tab } from './harness.js';
import { avatarIn, avatarOf, mineField, newSession, runtimeOf, transformIn } from './harness.js';
import {
    ACCEL_STEP,
    AVATAR_AT,
    CLAMPED,
    CODE_JUMP,
    CODE_RIGHT,
    CODE_UP,
    DRIFT_CAP,
    DRIFT_SPEED,
    FORCE_STEP,
    IMPULSE_X,
    JUMP_STRENGTH,
    MOVEMENT_WORLD,
    MOVER_DRIFT,
    MOVER_FAULT,
    MOVER_WALK,
    RUN_SPEED,
    S,
    STAGE_ORDER,
    W,
    WALK_SPEED,
    WALK_STEP,
    Walker,
} from '../dist/worlds/movement.js';

/** Ticks that comfortably outlast one send interval, so a press has been answered. */
const SETTLE = 12;

/** Where the test-side floor sits, far enough under the spawn that the fall is unmistakable. */
const FLOOR_Y = -60;

async function open(): Promise<{ session: Session; tab: Tab }> {
    const session = newSession(MOVEMENT_WORLD);
    const tab = await session.join('one');
    await session.live(tab);
    await session.step(SETTLE);
    return { session, tab };
}

async function press(session: Session, tab: Tab, widget: string, ticks = SETTLE): Promise<void> {
    session.press(tab, widget);
    await session.step(ticks);
}

/** A joined tab whose avatar carries one movement type, which is where every case below starts. */
async function installed(widget: string): Promise<{ session: Session; tab: Tab }> {
    const opened = await open();
    await press(opened.session, opened.tab, widget);
    return opened;
}

/**
 * A floor under everything the movement pass moves.
 *
 * The seam ships a sink that integrates and reports nothing blocked, so this is the smallest thing
 * a host filling it with real physics would provide — and the only way `blocked` is ever true.
 */
function floorAt(session: Session, y: number): void {
    const rt = session.sim.runtime;
    const at = rt.transforms;
    rt.physics = {
        move: (id, dt, velocity) => {
            const next = at.posY(id) + velocity.y * dt;
            const landed = next <= y;
            at.setPosition(id, at.posX(id) + velocity.x * dt, landed ? y : next, at.posZ(id));
            return {
                up: false,
                down: landed,
                left: false,
                right: false,
                forward: false,
                back: false,
            };
        },
    };
}

function idOf(tab: Tab): string {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) throw new Error('the tab has no local player');
    return id;
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

/** The same avatar, in the world the authority holds. */
function authoritative(session: Session, tab: Tab): ReturnType<typeof transformIn> {
    const rt = session.sim.runtime;
    const id = avatarIn(rt, idOf(tab));
    if (id === undefined) throw new Error('no avatar on the authority');
    return transformIn(rt, id);
}

/** This tab's own copy of a class the authority attached to its avatar. */
function attachedOn<T extends object>(tab: Tab, klass: new () => T): T | undefined {
    for (const attached of runtimeOf(tab).instances.forHost(entityKey(mine(tab)))) {
        if (attached.instance instanceof klass) return attached.instance;
    }
    return undefined;
}

function reading<T>(tab: Tab, field: string): T | undefined {
    return mineField<T>(tab, field);
}

function num(tab: Tab, field: string): number {
    return reading<number>(tab, field) ?? Number.NaN;
}

describe('a body with momentum', () => {
    it('drifts on the velocity a handler gave it, and stops dead when told to', async () => {
        const { session, tab } = await installed(W.drift);
        expect(reading<string>(tab, S.mover)).toBe(MOVER_DRIFT);

        await press(session, tab, W.push);
        expect(num(tab, S.vx)).toBe(DRIFT_SPEED);
        expect(num(tab, S.pace)).toBe(DRIFT_SPEED);
        // The shipped sink integrates and reports no contact, so nothing is ever under anything.
        expect(reading<boolean>(tab, S.floor)).toBe(false);
        expect(drawn(tab).x).toBeGreaterThan(AVATAR_AT.x);

        await press(session, tab, W.halt);
        expect(num(tab, S.vx)).toBe(0);
        expect(num(tab, S.ix)).toBe(0);

        await session.step(SETTLE);
        const stopped = drawn(tab).x;
        await session.step(30);
        expect(drawn(tab).x).toBe(stopped);
        expect(drawn(tab)).toEqual(authoritative(session, tab));
    });

    it('takes an impulse at once and a force once, dt-scaled', async () => {
        const { session, tab } = await installed(W.drift);
        await press(session, tab, W.push);

        // No dt: an impulse is a change of velocity, not a force applied over a tick.
        await press(session, tab, W.impulse);
        expect(num(tab, S.vx)).toBe(DRIFT_SPEED + IMPULSE_X);

        await press(session, tab, W.force);
        const pushed = DRIFT_SPEED + IMPULSE_X + FORCE_STEP;
        expect(num(tab, S.vx)).toBeCloseTo(pushed, 6);

        // Drained once and cleared, which is what lets a caller pass a rate rather than a step.
        await session.step(60);
        expect(num(tab, S.vx)).toBeCloseTo(pushed, 6);
    });

    it('caps the speed it was given without turning the direction', async () => {
        const { session, tab } = await installed(W.drift);
        await press(session, tab, W.launch);

        expect(num(tab, S.cap)).toBe(DRIFT_CAP);
        expect(num(tab, S.pace)).toBeCloseTo(DRIFT_CAP, 6);
        // 3:4 held, so a clamp never turns a diagonal into an axis.
        expect(num(tab, S.vx)).toBeCloseTo(CLAMPED.x, 6);
        expect(num(tab, S.vy)).toBeCloseTo(CLAMPED.y, 6);
    });

    it('coasts down one approach step at a time and lands exactly on zero', async () => {
        const { session, tab } = await installed(W.drift);
        await press(session, tab, W.push);
        await press(session, tab, W.grip);

        const coasting = num(tab, S.vx);
        expect(coasting).toBeGreaterThan(0);
        expect(coasting).toBeLessThan(DRIFT_SPEED);

        // Exactly zero, not nearly: `approach` stops on its target rather than stepping past it.
        await session.step(60);
        expect(num(tab, S.vx)).toBe(0);
    });
});

describe('a top-down mover on a bound key', () => {
    it('fills its intent from the keys held, and a diagonal is faster than a straight line', async () => {
        const { session, tab } = await installed(W.walk);
        expect(reading<string>(tab, S.mover)).toBe(MOVER_WALK);

        session.hold(tab, CODE_RIGHT);
        session.hold(tab, CODE_UP);
        await session.step(30);

        // No creator code set this: the input pass fills the intent from the player's move axes,
        // and a bound button reads as full deflection while it is down.
        expect(num(tab, S.ix)).toBe(1);
        expect(num(tab, S.iy)).toBe(1);
        expect(num(tab, S.vx)).toBe(WALK_SPEED);
        expect(num(tab, S.vy)).toBe(WALK_SPEED);
        // Unnormalized, because each axis is driven straight from its own key.
        expect(num(tab, S.pace)).toBeCloseTo(WALK_SPEED * Math.SQRT2, 6);

        session.releaseAll();
        await session.step(30);
        expect(num(tab, S.ix)).toBe(0);
        expect(num(tab, S.vx)).toBe(0);
        expect(num(tab, S.pace)).toBe(0);
    });

    it('runs its four stages in the order both endpoints are meant to replay', async () => {
        const { session, tab } = await installed(W.walk);
        session.hold(tab, CODE_RIGHT);
        await session.step(SETTLE);

        // Rebuilt every tick, so this is the order a real tick ran them in — `readIntent` is in it
        // because `tick` evaluates it as accelerate's argument.
        expect(reading<string>(tab, S.stages)).toBe(STAGE_ORDER);
    });

    it('stops reading the intent while it is disabled, without forgetting it', async () => {
        const { session, tab } = await installed(W.walk);
        session.hold(tab, CODE_RIGHT);
        await session.step(SETTLE);
        expect(num(tab, S.vx)).toBe(WALK_SPEED);

        // What the gate takes away is what the stages see, never what the input pass filled: the
        // key is still down, so re-enabling resumes rather than waiting for another press.
        await press(session, tab, W.off);
        expect(num(tab, S.vx)).toBe(0);
        expect(num(tab, S.ix)).toBe(1);

        await press(session, tab, W.on);
        expect(num(tab, S.vx)).toBe(WALK_SPEED);
    });

    it('keeps an intent a handler set for exactly the tick it was set on', async () => {
        const { session, tab } = await installed(W.walk);
        const from = drawn(tab).x;

        // One tick's worth and no more: the input pass refills the intent from this player's axes
        // every tick, and nothing is held — so a `setIntent` is gone by the tick after it.
        await press(session, tab, W.aim);
        expect(drawn(tab).x - from).toBeCloseTo(WALK_STEP, 6);
        await session.step(60);
        expect(drawn(tab).x - from).toBeCloseTo(WALK_STEP, 6);
    });
});

describe('the movement a tab is sent', () => {
    it('builds the class the authority attached, and never ticks it', async () => {
        const { session, tab } = await installed(W.walk);
        session.hold(tab, CODE_RIGHT);
        await session.step(30);

        // A movement type is a SyncedScript precisely so both ends hold one, and this tab does.
        const local = attachedOn(tab, Walker);
        expect(local).toBeDefined();
        expect(num(tab, S.vx)).toBe(WALK_SPEED);

        // It has nonetheless never taken a tick. `player.movement` is the movement pass's only
        // handle on an instance and the roster is the only thing that fills it, so the pass finds
        // nothing on a client and every stage above ran on the authority alone.
        expect(local?.speed).toBe(0);
        expect(local?.order).toBe('');
        const roster = runtimeOf(tab).playerManager.byId(idOf(tab));
        expect(roster).not.toBeNull();
        expect(roster?.movement).toBeUndefined();

        // Not "this tab does not predict": it rewinds and replays every delivery, over a scope its
        // own avatar is in.
        expect(tab.client.prediction?.counters.resimulations).toBeGreaterThan(0);
        expect(tab.client.prediction?.scope.has(mine(tab))).toBe(true);

        // So the tab agrees with the authority by being told, and the agreement is still exact.
        session.releaseAll();
        await session.step(30);
        expect(drawn(tab)).toEqual(authoritative(session, tab));
    });
});

describe('a platformer', () => {
    it('falls forever and refuses every jump when nothing reports it blocked', async () => {
        const { session, tab } = await installed(W.run);
        await session.step(60);

        // `grounded` is `blocked.down`, so on the shipped sink gravity never stops pulling and the
        // ground `jump` tests for never arrives — a platformer is not buildable on it.
        expect(reading<boolean>(tab, S.floor)).toBe(false);
        expect(drawn(tab).y).toBeLessThan(AVATAR_AT.y - 100);

        // The same tap lifts the same body in the case below, so what declines here is the handler
        // and not the binding.
        session.tap(tab, CODE_JUMP);
        await session.step(SETTLE);
        expect(num(tab, S.lift)).toBe(0);
        expect(num(tab, S.vy)).toBeLessThan(0);
    });

    it('lands on a floor, and a bound key lifts it by exactly its jump strength', async () => {
        const { session, tab } = await open();
        floorAt(session, FLOOR_Y);
        await press(session, tab, W.run);
        await session.stepUntil(() => reading<boolean>(tab, S.floor) === true);
        await session.step(SETTLE);
        expect(drawn(tab).y).toBe(FLOOR_Y);

        // `@onEvent('jump')` is declared on the movement class itself, which is why a bound key
        // jumps with no script of the creator's own behind it.
        session.tap(tab, CODE_JUMP);
        await session.step(SETTLE);
        expect(num(tab, S.lift)).toBe(JUMP_STRENGTH);
        expect(reading<boolean>(tab, S.floor)).toBe(false);

        await session.stepUntil(() => reading<boolean>(tab, S.floor) === true);
        await session.step(SETTLE);
        expect(drawn(tab).y).toBe(FLOOR_Y);
        expect(drawn(tab)).toEqual(authoritative(session, tab));
    });

    it('accelerates to its walk speed by one approach step a tick, and coasts down on friction', async () => {
        const { session, tab } = await open();
        floorAt(session, FLOOR_Y);
        await press(session, tab, W.run);
        await session.stepUntil(() => reading<boolean>(tab, S.floor) === true);

        session.hold(tab, CODE_RIGHT);
        await session.step(40);
        // One acceleration step was the whole of the first tick's speed, and forty ticks later it
        // sits exactly on `walkSpeed` rather than past it.
        expect(num(tab, S.first)).toBeCloseTo(ACCEL_STEP, 6);
        expect(num(tab, S.vx)).toBe(RUN_SPEED);

        session.releaseAll();
        await session.step(SETTLE);
        // Friction is a twentieth of the acceleration, so a body that stopped at once here would be
        // running something other than the approach the stage is written on.
        const coasting = num(tab, S.vx);
        expect(coasting).toBeGreaterThan(0);
        expect(coasting).toBeLessThan(RUN_SPEED);

        await session.step(180);
        expect(num(tab, S.vx)).toBe(0);
    });
});

describe('a movement stage that throws', () => {
    it('is contained by the pass, and charged to the movement instance', async () => {
        const { session, tab } = await installed(W.fault);
        await session.step(BREAKER_THRESHOLD + SETTLE);

        expect(session.trips).toHaveLength(1);
        expect(session.trips[0]).toMatchObject({
            scriptClass: 'Faulty',
            method: 'tick',
            event: '@movement',
        });
        // The tick survived every one of them: this tab is still live, and still being told about
        // its own body by a handler that runs after the pass that threw.
        expect(tab.client.state).toBe('live');
        expect(reading<string>(tab, S.mover)).toBe(MOVER_FAULT);
    });
});

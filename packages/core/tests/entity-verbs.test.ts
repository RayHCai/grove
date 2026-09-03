// The Entity verbs that aim at a target, the tween shortcuts written in terms of another tween, and
// the two that hold no state at all.
//
// Each one is a thin wrapper over something already covered, which is exactly why it needs its own
// case: a shortcut that passed the wrong argument through would be invisible everywhere else.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds, vec3 } from '@platform/math';
import { Loop } from '../src/loop/loop.js';
import { entityKey } from '../src/runtime/hosts.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { Entity } from '../src/runtime/entity.js';

afterEach(() => clearRuntime());

/** A spawned entity with the host record a tween needs to charge its scope to. */
function tweenable(rt: Runtime, x = 0, y = 0): Entity {
    const e = rt.wired.gameInstance.spawn('crate', x, y);
    rt.hosts.ensure(entityKey(e.entityId as number));
    return e;
}

/** Ticks past `seconds` of simulation; `step` takes a tick number, so the count is the clock. */
function run(loop: Loop, seconds: number, from = 0): number {
    const to = from + Math.ceil(seconds * 60) + 1;
    for (let tick = from + 1; tick <= to; tick++) loop.step(tick);
    return to;
}

describe('rotateBy', () => {
    it('accumulates, where setRotation assigns', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.setRotation(10);
        e.rotateBy(35);
        e.rotateBy(-5);
        expect(e.rotation).toBe(40);
    });
});

describe('moveToward', () => {
    it('steps along the line to the target by the speed it was given', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        // A 3-4-5 triangle, so a step of 5 lands exactly on (3, 4) and the arithmetic is checkable.
        e.moveToward(vec3(30, 40, 0), 5);
        expect(e.position.x).toBeCloseTo(3, 6);
        expect(e.position.y).toBeCloseTo(4, 6);
    });

    it('never overshoots, however large the speed', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.moveToward(vec3(10, 0, 0), 1000);
        expect(e.position.x).toBe(10);
    });

    it('takes another entity as the target, not only a point', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const target = rt.wired.gameInstance.spawn('crate', 100, 0);
        e.moveToward(target, 25);
        expect(e.position.x).toBe(25);
    });

    it('stands still when it is already there, rather than dividing by a zero distance', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 7, 7);
        e.moveToward(vec3(7, 7, 0), 10);
        expect(e.position.x).toBe(7);
        expect(e.position.y).toBe(7);
    });
});

describe('faceToward', () => {
    it('assigns the bearing to the target rather than turning by it', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.setRotation(123);
        e.faceToward(vec3(0, 10, 0));
        expect(e.rotation).toBeCloseTo(90, 6);
        // Twice from a different start: an implementation that added would drift on the second call.
        e.faceToward(vec3(0, 10, 0));
        expect(e.rotation).toBeCloseTo(90, 6);
    });

    it('reads due west as 180, so the whole circle is available', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.faceToward(vec3(-10, 0, 0));
        expect(Math.abs(e.rotation)).toBeCloseTo(180, 6);
    });
});

describe('distanceTo', () => {
    it('measures in the plane, ignoring the axis the 2D backend reserves', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        expect(e.distanceTo(vec3(3, 4, 0))).toBeCloseTo(5, 6);
        // z is reserved for the 3D backend, so it must not enter a 2D measurement.
        expect(e.distanceTo(vec3(3, 4, 99))).toBeCloseTo(5, 6);
    });

    it('is zero to itself', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 5, 5);
        expect(e.distanceTo(e)).toBe(0);
    });
});

describe('the tween shortcuts', () => {
    it('glideBy is relative to where the entity stood when it was called', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = tweenable(rt, 10, 20);
        void e.glideBy(30, -5, 1);
        run(loop, 1);
        expect(e.position.x).toBeCloseTo(40, 3);
        expect(e.position.y).toBeCloseTo(15, 3);
    });

    it('fadeOut reaches zero and fadeIn reaches one', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = tweenable(rt);
        void e.fadeOut(1);
        const at = run(loop, 1);
        expect(e.opacity).toBeCloseTo(0, 3);

        void e.fadeIn(1);
        run(loop, 1, at);
        expect(e.opacity).toBeCloseTo(1, 3);
    });

    it('spinTo lands on the angle it names, where spin adds one', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = tweenable(rt);
        e.setRotation(90);
        void e.spinTo(270, 1);
        run(loop, 1);
        expect(e.rotation).toBeCloseTo(270, 3);
    });
});

describe('isTouching', () => {
    it('answers the same question getTouching does, as a predicate', () => {
        const rt = loadGame({ bounds: bounds(-100, 100, 100, -100) });
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        const b = rt.wired.gameInstance.spawn('crate', 0, 0).tag('enemy');
        // Nothing in the template pipeline writes a collider, so an untouched entity touches nothing.
        expect(a.isTouching()).toBe(false);

        a.collider = { enabled: true, isTrigger: false, bounds: bounds(-10, 10, 10, -10) };
        b.collider = { enabled: true, isTrigger: false, bounds: bounds(-10, 10, 10, -10) };
        expect(a.isTouching()).toBe(true);
        expect(a.isTouching('enemy')).toBe(true);
        expect(a.isTouching('nobody')).toBe(false);
    });
});

describe('the verbs that hold nothing', () => {
    it('stopAnimation chains and leaves the animation slot alone', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        // Specified as template-configured; nothing in the template pipeline writes it, so it is
        // absent until a script assigns one — and stopping does not mint one either.
        expect(e.animation).toBeUndefined();
        expect(e.stopAnimation()).toBe(e);
        expect(e.animation).toBeUndefined();
    });

    it('think chains, and its timed form resolves without leaving a bubble behind', async () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = tweenable(rt);
        // A thought is specified as a bubble but holds nothing today: the untimed call is a bare
        // chain and the timed one is the sleep alone, so neither is observable on the entity.
        expect(e.think('hm')).toBe(e);

        const done = e.think('hm', 1);
        run(loop, 1);
        await expect(done).resolves.toBeUndefined();
        expect(e.tags).toEqual([]);
    });

    it('playEffect reaches the effect sink and chains', () => {
        const rt = loadGame();
        const played: Array<[string, unknown]> = [];
        rt.effects = { play: (kind: string, payload?: unknown) => played.push([kind, payload]) };
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        expect(e.playEffect('puff')).toBe(e);
        expect(played).toHaveLength(1);
        expect(played[0]?.[0]).toBe('effect');
    });

    it('play reaches the same sink under its own kind, and resolves', async () => {
        const rt = loadGame();
        const played: string[] = [];
        rt.effects = { play: (kind: string) => played.push(kind) };
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        await e.play('walk');
        expect(played).toEqual(['animation']);
    });
});

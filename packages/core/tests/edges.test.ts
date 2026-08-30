// The tick order's edges: region crossings, a contact's enter edge, the host's end, and the
// countdown the loop advances. Each is a diff against a previous tick, so each is tested by
// stepping rather than by calling once.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds } from '@platform/math';
import { Edges, Session } from '../dist/testkit/fixtures.js';
import { endGame, joinPlayer, leavePlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { Countdown } from '../src/runtime/wrappers.js';
import type { Entity } from '../src/runtime/entity.js';
import { entityKey } from '../src/runtime/hosts.js';
import { instanceOf } from './helpers.js';

afterEach(() => clearRuntime());

const ARENA = { name: 'arena', bounds: bounds(-10, 10, 10, -10) };

function world(): Runtime {
    return loadGame({ bounds: bounds(-500, 500, 500, -500), regions: [ARENA] });
}

/** A unit-square collider, so two bodies at the same point overlap and a metre apart do not. */
function boxed(entity: Entity): Entity {
    entity.collider = { enabled: true, isTrigger: false, bounds: bounds(-0.5, 0.5, 0.5, -0.5) };
    return entity;
}

describe('region enter and exit', () => {
    it('fires exactly once per crossing, not once per tick inside', () => {
        const rt = world();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('walker', 100, 0);
        e.addScript(Edges as never);
        const script = instanceOf<Edges>(rt, e, 'Edges');

        loop.step(1); // outside
        expect(script.entered).toStrictEqual([]);

        e.setPosition(0, 0);
        loop.step(2); // crossed in
        loop.step(3); // still inside — the edge already fired
        expect(script.entered).toStrictEqual(['arena']);
        expect(script.exited).toStrictEqual([]);

        e.setPosition(100, 0);
        loop.step(4); // crossed out
        loop.step(5);
        expect(script.exited).toStrictEqual(['arena']);

        e.setPosition(0, 0);
        loop.step(6); // and back in: a second crossing is a second edge
        expect(script.entered).toStrictEqual(['arena', 'arena']);
    });

    it('does not fire @onExit for an entity that left by being destroyed', () => {
        const rt = world();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('walker', 0, 0);
        e.addScript(Edges as never);
        const script = instanceOf<Edges>(rt, e, 'Edges');

        loop.step(1);
        expect(script.entered).toStrictEqual(['arena']);

        e.destroy();
        loop.step(2);
        // Its @onEnd is the notification that it stopped existing; an exit as well would report a
        // crossing it never made.
        expect(script.exited).toStrictEqual([]);
        expect(script.ends).toBe(1);
    });
});

describe('@onCollide is the enter edge', () => {
    it('fires once while two bodies stay overlapped, and again after they separate', () => {
        const rt = world();
        const loop = new Loop(rt);
        const self = boxed(rt.wired.gameInstance.spawn('walker', 200, 0));
        boxed(rt.wired.gameInstance.spawn('spike', 300, 0)).tag('hazard');
        self.addScript(Edges as never);
        const script = instanceOf<Edges>(rt, self, 'Edges');

        loop.step(1); // apart
        expect(script.contacts).toBe(0);

        self.setPosition(300, 0);
        loop.step(2); // touched
        loop.step(3); // still touching — `getTouching` answers that, not a second dispatch
        expect(script.contacts).toBe(1);

        self.setPosition(200, 0);
        loop.step(4); // separated
        self.setPosition(300, 0);
        loop.step(5); // touched again
        expect(script.contacts).toBe(2);
    });
});

describe('@onEnd', () => {
    it('runs at the destroy drain, while the host record is still readable', () => {
        const rt = world();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('walker', 200, 0);
        e.addScript(Edges as never);
        const script = instanceOf<Edges>(rt, e, 'Edges');
        const key = entityKey(e.entityId as number);

        let hostAtEnd = false;
        script.probe = () => {
            hostAtEnd = rt.hosts.get(key) !== undefined;
        };

        e.destroy();
        expect(script.ends).toBe(0); // logical-now destroy, teardown at the drain
        loop.step(1);

        expect(script.ends).toBe(1);
        expect(hostAtEnd).toBe(true);
        expect(rt.hosts.get(key)).toBeUndefined(); // and torn down after
    });

    it('runs on the player host before the roster removal', async () => {
        const rt = world();
        const player = joinPlayer(rt, 'p1', 'Ada');
        player.addScript(Session as never);
        const script = [...rt.instances.forHost('player:p1')][0]!.instance as Session;

        let rosterAtEnd = -1;
        script.probe = () => {
            rosterAtEnd = rt.wired.playerManager.players.length;
        };

        leavePlayer(rt, 'p1');
        expect(script.ends).toBe(1);
        expect(rosterAtEnd).toBe(1);
        expect(rt.wired.playerManager.byId('p1')).toBeNull();
    });

    it('endGame runs it at every attached host, because the world ending ends all of them', async () => {
        const rt = world();
        const e = rt.wired.gameInstance.spawn('walker', 0, 0);
        e.addScript(Edges as never);
        const script = instanceOf<Edges>(rt, e, 'Edges');

        await endGame(rt);
        expect(script.ends).toBe(1);
    });
});

describe('countdowns', () => {
    it('advances one tick per step once started, and fires onZero at the bottom', () => {
        const rt = world();
        const loop = new Loop(rt);
        let fired = 0;
        // Two ticks at the default 60 Hz.
        const countdown = new Countdown(2 / 60, () => {
            fired += 1;
        });

        loop.step(1);
        expect(countdown.remaining).toBeCloseTo(2 / 60); // not started, so not advancing

        countdown.start();
        loop.step(2);
        expect(countdown.remaining).toBeCloseTo(1 / 60);
        loop.step(3);
        expect(fired).toBe(1);
        expect(countdown.running).toBe(false);

        loop.step(4);
        expect(fired).toBe(1); // and it left the registry, so it cannot fire twice
    });

    it('is not advanced again by a replayed tick', () => {
        const rt = world();
        const loop = new Loop(rt);
        const countdown = new Countdown(10);
        countdown.start();

        loop.step(1);
        const after = countdown.remaining;
        loop.step(1, { replay: true });
        loop.step(1, { replay: true });
        expect(countdown.remaining).toBe(after);
    });

    it('contains a throw from onZero rather than letting it escape the tick', () => {
        const rt = world();
        const loop = new Loop(rt);
        const countdown = new Countdown(1 / 60, () => {
            throw new Error('onZero always throws');
        });
        countdown.start();

        expect(() => loop.step(1)).not.toThrow();
        expect(rt.log.records.some((r) => r.stack.includes('onZero always throws'))).toBe(true);
    });
});

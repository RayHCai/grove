// The movement contract both endpoints replay.
//
// `tick`'s stage order — accelerate, applyForces, clampSpeed, move — is what a client re-runs when
// it resimulates, so a subclass overriding a stage changes prediction and a subclass overriding
// `tick` itself changes the order and desyncs. Everything below drives real ticks rather than
// calling `tick` directly, because the pass is where the ordering actually lives.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds } from '@platform/math';
import type { Vec3 } from '@platform/math';
// From dist, like every other decorator-bearing import here: `movement.ts` declares
// `@onEvent('jump')`, and the test transform passes standard decorators through unlowered.
import { BaseMovement, PlatformerMovement, TopDownMovement } from '../dist/runtime/movement.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';
import { Loop } from '../src/loop/loop.js';
import { noBlocked } from '../src/runtime/seams.js';
import type { Blocked } from '../src/runtime/seams.js';
import type { EntityId } from '../src/ids.js';

afterEach(() => clearRuntime());

const WORLD = bounds(-1000, 1000, 1000, -1000);

/** Records the stage order, so `tick` can be asserted as a sequence rather than an outcome. */
const stages: string[] = [];

class Probe extends BaseMovement {
    protected accelerate(intent: Vec3): void {
        stages.push('accelerate');
        this.setVelocity(intent.x * 100, intent.y * 100);
    }

    protected override applyForces(dt: number): void {
        stages.push('applyForces');
        super.applyForces(dt);
    }

    protected override clampSpeed(): void {
        stages.push('clampSpeed');
        super.clampSpeed();
    }
}

/** The dist copy's instance type; the `src` declaration is a different class to `tsc`. */
type Movement = BaseMovement;

function world(movement: new () => Movement): {
    rt: Runtime;
    loop: Loop;
    player: Player;
    move: Movement;
} {
    const rt = loadGame({ bounds: WORLD, simRate: 60 });
    const loop = new Loop(rt);
    const player = rt.wired.playerManager.create('p1', 'Ada');
    player.spawn();
    player.setMovement(movement as never);
    return { rt, loop, player, move: player.movement as unknown as Movement };
}

describe('the tick contract', () => {
    it('runs its stages in the order both endpoints replay', () => {
        stages.length = 0;
        const { loop, move } = world(Probe);
        move.setIntent(1, 0);
        loop.step(1);
        // `move` is not in the list because it is the one stage a subclass cannot reach.
        expect(stages).toStrictEqual(['accelerate', 'applyForces', 'clampSpeed']);
    });

    it('writes position through the physics seam rather than the transform store', () => {
        const { rt, loop, player, move } = world(TopDownMovement);
        const seen: Array<{ id: EntityId; dt: number }> = [];
        const real = rt.physics;
        rt.physics = {
            move: (id, dt, velocity): Blocked => {
                seen.push({ id, dt });
                return real.move(id, dt, velocity);
            },
        };

        move.setIntent(1, 0);
        loop.step(1);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe(player.avatar.entityId);
        expect(seen[0]?.dt).toBe(1 / 60);
    });

    it('is skipped for a player whose avatar died', () => {
        // The instance stays live after the avatar goes, and the sink would otherwise keep writing
        // positions for whatever entity takes over the released slot.
        const { rt, loop, player, move } = world(TopDownMovement);
        let calls = 0;
        rt.physics = {
            move: (): Blocked => {
                calls += 1;
                return noBlocked();
            },
        };

        move.setIntent(1, 0);
        loop.step(1);
        expect(calls).toBe(1);

        player.avatar.destroy();
        rt.entityManager.drainDestroyed();
        loop.step(2);
        loop.step(3);
        expect(calls).toBe(1);
    });
});

describe('BaseMovement state', () => {
    it('setVelocity and setIntent are separate, and stop clears both', () => {
        const { move } = world(Probe);
        move.setVelocity(3, 4, 5);
        move.setIntent(1, 1, 1);
        expect(move.velocity).toEqual({ x: 3, y: 4, z: 5 });
        expect(move.intent).toEqual({ x: 1, y: 1, z: 1 });

        move.stop();
        expect(move.velocity).toEqual({ x: 0, y: 0, z: 0 });
        expect(move.intent).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('speed is the magnitude of the velocity', () => {
        const { move } = world(Probe);
        move.setVelocity(3, 4);
        expect(move.speed).toBe(5);
    });

    it('impulse adds to velocity immediately, without dt', () => {
        const { move } = world(Probe);
        move.setVelocity(1, 0);
        move.impulse(2, 3);
        expect(move.velocity).toEqual({ x: 3, y: 3, z: 0 });
    });

    it('addForce is dt-scaled once on drain, so callers never scale', () => {
        const { loop, move } = world(TopDownMovement);
        move.setVelocity(0, 0);
        move.addForce(0, 600);
        loop.step(1);
        // 600 * 1/60 = 10, applied once — and the accumulator is cleared, so the next tick adds none.
        const afterOne = move.velocity.y;
        expect(afterOne).toBeCloseTo(10, 9);

        move.setIntent(0, 0);
        loop.step(2);
        expect(move.velocity.y).toBeCloseTo(0, 9); // TopDown's accelerate owns y and zeroes it
    });

    it('clampSpeed holds the direction while capping the magnitude', () => {
        const { loop, move } = world(Probe);
        move.maxSpeed = 10;
        move.setIntent(3, 4); // Probe accelerates to 100x the intent — far over the cap
        loop.step(1);
        expect(move.speed).toBeCloseTo(10, 9);
        // 3:4 preserved, so a clamp never turns a diagonal into an axis.
        expect(move.velocity.x / move.velocity.y).toBeCloseTo(3 / 4, 9);
    });

    it('enabled false zeroes the intent the stages read, not the intent itself', () => {
        const { loop, move } = world(TopDownMovement);
        move.setIntent(1, 0);
        move.enabled = false;
        loop.step(1);
        expect(move.velocity.x).toBe(0);
        // Still what the creator set: re-enabling resumes rather than needing the intent again.
        expect(move.intent.x).toBe(1);

        move.enabled = true;
        loop.step(2);
        expect(move.velocity.x).toBeGreaterThan(0);
    });

    it('blocked reports what the physics seam last answered', () => {
        const { rt, loop, move } = world(TopDownMovement);
        // The four axes the creator surface declares; the seam's own `Blocked` also carries
        // forward/back, which a 2D API deliberately does not expose.
        expect(move.blocked).toMatchObject({
            up: false,
            down: false,
            left: false,
            right: false,
        });

        rt.physics = { move: (): Blocked => ({ ...noBlocked(), down: true }) };
        loop.step(1);
        expect(move.blocked.down).toBe(true);
    });
});

describe('TopDownMovement', () => {
    it('drives velocity straight from intent at walkSpeed', () => {
        const { loop, move } = world(TopDownMovement);
        const top = move as TopDownMovement;
        top.walkSpeed = 200;
        top.setIntent(1, 0);
        loop.step(1);
        expect(top.velocity).toEqual({ x: 200, y: 0, z: 0 });
    });

    it('stops the moment the intent goes neutral — no momentum', () => {
        const { loop, move } = world(TopDownMovement);
        move.setIntent(1, 0);
        loop.step(1);
        move.setIntent(0, 0);
        loop.step(2);
        expect(move.velocity.x).toBe(0);
    });

    it('moves the avatar the distance the velocity implies', () => {
        const { loop, player, move } = world(TopDownMovement);
        (move as TopDownMovement).walkSpeed = 60;
        move.setIntent(1, 0);
        const from = player.avatar.position.x;
        loop.step(1);
        expect(player.avatar.position.x - from).toBeCloseTo(1, 9); // 60 units/s at 1/60 s
    });
});

describe('PlatformerMovement', () => {
    it('accelerates toward walkSpeed rather than snapping to it', () => {
        const { loop, move } = world(PlatformerMovement);
        move.setIntent(1, 0);
        loop.step(1);
        const first = move.velocity.x;
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan((move as PlatformerMovement).walkSpeed);

        loop.step(2);
        expect(move.velocity.x).toBeGreaterThan(first);
    });

    it('decelerates by friction when the intent goes neutral', () => {
        const { loop, move } = world(PlatformerMovement);
        move.setIntent(1, 0);
        for (let t = 1; t <= 20; t++) loop.step(t);
        const running = move.velocity.x;

        move.setIntent(0, 0);
        loop.step(21);
        expect(move.velocity.x).toBeLessThan(running);
        expect(move.velocity.x).toBeGreaterThanOrEqual(0);
    });

    it('falls while airborne, because nothing is under it', () => {
        const { loop, move } = world(PlatformerMovement);
        expect((move as PlatformerMovement).grounded).toBe(false);
        loop.step(1);
        expect(move.velocity.y).toBeLessThan(0);
        const first = move.velocity.y;
        loop.step(2);
        expect(move.velocity.y).toBeLessThan(first); // and keeps accelerating downward
    });

    it('does not add gravity while grounded', () => {
        const { rt, loop, move } = world(PlatformerMovement);
        rt.physics = { move: (): Blocked => ({ ...noBlocked(), down: true }) };

        loop.step(1); // this tick still reads the previous blocked state
        loop.step(2);
        const settled = move.velocity.y;
        loop.step(3);
        expect(move.velocity.y).toBe(settled);
    });

    it('jumps only from the ground', () => {
        const { rt, loop, move } = world(PlatformerMovement);
        const platformer = move as PlatformerMovement;

        // Airborne: the handler runs and declines, which is the branch a creator feels as a
        // double-jump that does not happen.
        platformer.jump();
        expect(platformer.velocity.y).toBe(0);

        rt.physics = { move: (): Blocked => ({ ...noBlocked(), down: true }) };
        loop.step(1);
        expect(platformer.grounded).toBe(true);

        platformer.jump();
        expect(platformer.velocity.y).toBe(platformer.jumpStrength);
    });

    it('keeps horizontal velocity through a jump', () => {
        const { rt, loop, move } = world(PlatformerMovement);
        const platformer = move as PlatformerMovement;
        rt.physics = { move: (): Blocked => ({ ...noBlocked(), down: true }) };

        platformer.setIntent(1, 0);
        for (let t = 1; t <= 10; t++) loop.step(t);
        const running = platformer.velocity.x;
        expect(running).toBeGreaterThan(0);

        platformer.jump();
        expect(platformer.velocity.x).toBe(running);
    });

    it('declares its jump as a handler, so the input pass reaches it', () => {
        // `@onEvent('jump')` on the movement class is why a panel-bound jump button works with no
        // script of the creator's own; a plain method would need one.
        const { rt, player } = world(PlatformerMovement);
        const si = rt.instances.forInstance(player.movement!);
        expect(si?.handlers.map((h) => `${h.kind}:${h.event}`)).toStrictEqual(['onEvent:jump']);
    });
});

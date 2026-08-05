// BaseMovement: a SyncedScript<Entity> with a sealed tick (DESIGN §4.1, api_spec.ts:653).
// The order IS the prediction contract, so `tick` is sealed and overriding it is a
// load-time error. Stages 1-3 are real; stage 4 (move) delegates to the PhysicsSink whose
// null implementation integrates position and sets `blocked` all-false — a platformer runs
// and falls but does not land until Rapier fills the seam.
//
// velocity and intent are readonly and setter-written (§3.1); the one write channel is
// setVelocity. impulse is a discrete Δvelocity never dt-scaled; addForce accumulates and
// drains in applyForces.

import type { Vec3 } from '@platform/math';
import { approach as mathApproach, vec3, vec3Length } from '@platform/math';
import { SyncedScript } from '../script/bases.js';
import { onEvent } from '../script/decorators.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Blocked } from './seams.js';
import { noBlocked } from './seams.js';
import { currentRuntime } from './runtime.js';

export abstract class BaseMovement extends SyncedScript<Entity> {
    readonly player!: Player;

    #vx = 0;
    #vy = 0;
    #vz = 0;
    #ix = 0;
    #iy = 0;
    #iz = 0;
    #fx = 0;
    #fy = 0;
    #fz = 0;
    #blocked: Blocked = noBlocked();

    enabled = true;
    maxSpeed = 600;

    get velocity(): Vec3 {
        return vec3(this.#vx, this.#vy, this.#vz);
    }

    get intent(): Vec3 {
        return vec3(this.#ix, this.#iy, this.#iz);
    }

    get speed(): number {
        return vec3Length(this.velocity);
    }

    get blocked(): { up: boolean; down: boolean; left: boolean; right: boolean } {
        return this.#blocked;
    }

    // ── the sealed tick (§4.1) — do not override ────────────────────────────────
    tick(dt: number): void {
        this.accelerate(this.readIntent(), dt); // 1: intent -> velocity
        this.applyForces(dt); // 2: gravity, friction, drained forces
        this.clampSpeed(); // 3: maxSpeed
        this.#move(dt); // 4: engine sweep/slide/write position/set blocked
    }

    // ── public writes ───────────────────────────────────────────────────────────
    setVelocity(x: number, y: number, z = 0): void {
        this.#vx = x;
        this.#vy = y;
        this.#vz = z;
    }

    setIntent(x: number, y: number, z = 0): void {
        this.#ix = x;
        this.#iy = y;
        this.#iz = z;
    }

    impulse(x: number, y: number, z = 0): void {
        this.#vx += x;
        this.#vy += y;
        this.#vz += z;
    }

    addForce(x: number, y: number, z = 0): void {
        this.#fx += x;
        this.#fy += y;
        this.#fz += z;
    }

    stop(): void {
        this.setVelocity(0, 0, 0);
        this.setIntent(0, 0, 0);
    }

    /** @internal — the loop fills intent from the panel-mapped move axes before tick. */
    fillIntent(x: number, y: number, z = 0): void {
        this.#ix = x;
        this.#iy = y;
        this.#iz = z;
    }

    // ── hooks ─────────────────────────────────────────────────────────────────────
    protected abstract accelerate(intent: Vec3, dt: number): void;

    protected readIntent(): Vec3 {
        return this.enabled ? this.intent : vec3(0, 0, 0);
    }

    protected applyForces(dt: number): void {
        // Drain the force accumulator, dt-scaled once here rather than at each call site.
        this.#vx += this.#fx * dt;
        this.#vy += this.#fy * dt;
        this.#vz += this.#fz * dt;
        this.#fx = 0;
        this.#fy = 0;
        this.#fz = 0;
    }

    protected clampSpeed(): void {
        const s = this.speed;
        if (s > this.maxSpeed && s > 0) {
            const k = this.maxSpeed / s;
            this.#vx *= k;
            this.#vy *= k;
            this.#vz *= k;
        }
    }

    protected approach(current: number, target: number, rate: number): number {
        return mathApproach(current, target, rate);
    }

    /** Engine-owned stage 4: sweep, slide, write position, correct velocity, set blocked. */
    #move(dt: number): void {
        const host = this.host as unknown as Entity;
        this.#blocked = currentRuntime().physics.move(host.entityId, dt, {
            x: this.#vx,
            y: this.#vy,
            z: this.#vz,
        });
    }
}

export class TopDownMovement extends BaseMovement {
    walkSpeed = 300;

    protected accelerate(intent: Vec3): void {
        this.setVelocity(intent.x * this.walkSpeed, intent.y * this.walkSpeed);
    }
}

export class PlatformerMovement extends BaseMovement {
    walkSpeed = 260;
    gravity = 1400;
    jumpStrength = 520;
    acceleration = 2600;
    friction = 3000;

    get grounded(): boolean {
        return this.blocked.down;
    }

    protected accelerate(intent: Vec3, dt: number): void {
        const target = intent.x * this.walkSpeed;
        const rate = intent.x !== 0 ? this.acceleration : this.friction;
        const vx = this.approach(this.velocity.x, target, rate * dt);
        this.setVelocity(vx, this.velocity.y); // y is gravity's, not ours
    }

    protected override applyForces(dt: number): void {
        if (!this.grounded) this.addForce(0, -this.gravity);
        super.applyForces(dt);
    }

    @onEvent('jump')
    jump(): void {
        if (this.grounded) this.setVelocity(this.velocity.x, this.jumpStrength);
    }
}

export type Movement = BaseMovement;

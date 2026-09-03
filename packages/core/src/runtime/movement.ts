// The stage order in `tick` is the prediction contract both endpoints replay, so subclasses
// override the hooks and never `tick` itself.

import type { Vec3 } from '@platform/math';
import { approach as mathApproach, vec3, vec3Length } from '@platform/math';
import { SyncedScript } from '../script/bases.js';
import { onEvent } from '../script/decorators.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Blocked } from './seams.js';
import { noBlocked } from './seams.js';
import { scriptRuntime } from './script-runtime.js';

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

    tick(dt: number): void {
        this.accelerate(this.readIntent(), dt);
        this.applyForces(dt);
        this.clampSpeed();
        this.#move(dt);
    }

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

    protected abstract accelerate(intent: Vec3, dt: number): void;

    protected readIntent(): Vec3 {
        return this.enabled ? this.intent : vec3(0, 0, 0);
    }

    protected applyForces(dt: number): void {
        // dt-scaled once on drain, so addForce callers never scale.
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

    #move(dt: number): void {
        const host = this.host as unknown as Entity;
        // The runtime wiring attached this instance to, not the ambient one: resolving it per call
        // sent a tick's position writes into whichever world happened to be current.
        this.#blocked = scriptRuntime(this).physics.move(host.entityId, dt, {
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

    // Always false until a physics sink stops the body, so gravity never stops pulling and
    // `jump` never pushes — a platformer is not buildable on the null sink.
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

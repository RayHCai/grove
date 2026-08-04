import type { Vec3 } from '@platform/math';
import { SyncedScript } from '../script/bases.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';

export abstract class BaseMovement extends SyncedScript<Entity> {
    readonly player!: Player;

    readonly velocity!: Vec3;
    readonly intent!: Vec3;

    enabled!: boolean;
    readonly speed!: number;
    maxSpeed!: number;

    readonly blocked!: { up: boolean; down: boolean; left: boolean; right: boolean };

    tick(_dt: number): void {}

    setVelocity(_x: number, _y: number, _z?: number): void {}
    setIntent(_x: number, _y: number, _z?: number): void {}
    impulse(_x: number, _y: number, _z?: number): void {}
    addForce(_x: number, _y: number, _z?: number): void {}
    stop(): void {}

    protected abstract accelerate(_intent: Vec3, _dt: number): void;
    protected readIntent(): Vec3 { return this.intent; }
    protected applyForces(_dt: number): void {}
    protected clampSpeed(): void {}
    protected approach(_current: number, _target: number, _rate: number): number { return _current; }
}

export class TopDownMovement extends BaseMovement {
    walkSpeed!: number;

    protected accelerate(_intent: Vec3, _dt: number): void {}
}

export class PlatformerMovement extends BaseMovement {
    walkSpeed!: number;
    gravity!: number;
    jumpStrength!: number;
    acceleration!: number;
    friction!: number;

    readonly grounded!: boolean;

    protected accelerate(_intent: Vec3, _dt: number): void {}
    protected override applyForces(_dt: number): void {}
    jump(): void {}
}

export type Movement = BaseMovement;

import type { Vec3, Bounds, Easing } from '@platform/math';
import type { AssetRef } from './assets.js';
import type { BaseScript } from '../script/bases.js';

export interface Collider {
    enabled: boolean;
    isTrigger: boolean;
    readonly bounds: Bounds;
}

export interface Animation {
    speed: number;
    readonly clip: string;
}

export class Entity {
    readonly id!: string;
    readonly owner!: Player | null;

    readonly position!: Vec3;
    readonly rotation!: number;
    readonly scale!: number;
    opacity!: number;
    layer!: number;

    setPosition(_x: number, _y: number): this { return this; }
    setRotation(_degrees: number): this { return this; }
    rotateBy(_degrees: number): this { return this; }
    setScale(_scale: number): this { return this; }
    moveBy(_dx: number, _dy: number): this { return this; }
    moveToward(_target: Entity | Vec3, _speed: number): this { return this; }
    faceToward(_target: Entity | Vec3): this { return this; }
    distanceTo(_target: Entity | Vec3): number { return 0; }

    glideTo(_x: number, _y: number, _seconds: number, _easing?: Easing): Promise<void> { return Promise.resolve(); }
    glideBy(_dx: number, _dy: number, _seconds: number, _easing?: Easing): Promise<void> { return Promise.resolve(); }
    fadeTo(_opacity: number, _seconds: number): Promise<void> { return Promise.resolve(); }
    fadeIn(_seconds: number): Promise<void> { return Promise.resolve(); }
    fadeOut(_seconds: number): Promise<void> { return Promise.resolve(); }
    growTo(_scale: number, _seconds: number): Promise<void> { return Promise.resolve(); }
    spin(_degrees: number, _seconds: number): Promise<void> { return Promise.resolve(); }
    spinTo(_degrees: number, _seconds: number): Promise<void> { return Promise.resolve(); }

    attachTo(_parent: Entity): this { return this; }
    detach(): this { return this; }
    readonly parent!: Entity | null;
    readonly children!: Entity[];

    tag(_name: string): this { return this; }
    untag(_name: string): this { return this; }
    hasTag(_name: string): boolean { return false; }
    readonly tags!: string[];

    collider?: Collider;
    animation?: Animation;

    getTouching(_tag?: string, _opts?: { asSeen?: boolean }): Entity[] { return []; }
    isTouching(_tag?: string, _opts?: { asSeen?: boolean }): boolean { return false; }

    show(): this { return this; }
    hide(): this { return this; }

    play(_clip: AssetRef, _opts?: { loop?: boolean }): Promise<void> { return Promise.resolve(); }
    stopAnimation(): this { return this; }
    playEffect(_name: AssetRef, _opts?: { loop?: boolean }): this { return this; }

    say(_text: string): this;
    say(_text: string, _seconds: number): Promise<void>;
    say(_text: string, _seconds?: number): this | Promise<void> {
        if (_seconds !== undefined) return Promise.resolve();
        return this;
    }

    think(_text: string): this;
    think(_text: string, _seconds: number): Promise<void>;
    think(_text: string, _seconds?: number): this | Promise<void> {
        if (_seconds !== undefined) return Promise.resolve();
        return this;
    }

    clearSay(): this { return this; }

    destroy(): void {}
    readonly alive!: boolean;

    addScript(_script: new () => BaseScript<Entity>): this { return this; }

    send(_event: string, _payload?: Record<string, unknown>): Promise<void> { return Promise.resolve(); }
}

// Forward reference resolved by player.ts importing entity.ts
import type { Player } from './player.js';

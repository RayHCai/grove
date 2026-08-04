import type { Vec3 } from '@platform/math';
import type { BaseScript } from '../script/bases.js';
import type { Camera } from './camera.js';
import type { Entity } from './entity.js';
import type { Storage } from './wrappers.js';

export interface Cursor {
    readonly position: Vec3;
    readonly screenPosition: Vec3;
    readonly over: Entity | null;
    readonly isDown: boolean;
    visible: boolean;
    setIcon(icon: 'crosshair' | 'hand' | 'default' | string): void;
    lock(): void;
    unlock(): void;
}

export interface InputBindings {
    rebind(action: string, bindings: string[]): void;
    addBinding(action: string, binding: string): void;
    getBindings(action: string): string[];
    resetBindings(action?: string): void;
    setContext(context: string): void;
}

export interface ActionState {
    held(action: string): boolean;
    pressed(action: string): boolean;
    released(action: string): boolean;
    axis(action: string): number;
}

export class Player {
    readonly id!: string;
    readonly name!: string;
    readonly index!: number;
    readonly avatar!: Entity;
    readonly camera!: Camera;
    readonly cursor!: Cursor;
    readonly input!: InputBindings;
    readonly storage!: Storage;

    spawn(): void {}
    spectate(): void {}
    respawn(): void {}
    teleportTo(_x: number, _y: number): void {}

    movement?: BaseMovement;
    setMovement(_movement: new () => BaseMovement): this { return this; }

    addScript(_script: new () => BaseScript<Player>): this { return this; }
}

// Resolve the circular reference
import type { BaseMovement } from './movement.js';

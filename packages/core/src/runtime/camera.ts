import type { Vec3, Bounds, Easing } from '@platform/math';
import type { BaseScript } from '../script/bases.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';

export class Camera {
    readonly player!: Player;

    zoom!: number;
    readonly position!: Vec3;
    bounds!: Bounds | string | null;
    readonly viewport!: Bounds;

    follow(_target: Player | Entity | null): this { return this; }
    moveTo(_x: number, _y: number): this { return this; }
    shake(_strength: number, _seconds: number): this { return this; }
    glideTo(_x: number, _y: number, _seconds: number, _easing?: Easing): Promise<void> { return Promise.resolve(); }
    zoomTo(_zoom: number, _seconds: number, _easing?: Easing): Promise<void> { return Promise.resolve(); }

    addScript(_script: new () => BaseScript<Camera>): this { return this; }
}

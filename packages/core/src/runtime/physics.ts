// Integrates position and reports nothing blocked: a platformer runs and falls, but does not
// land until Rapier fills this seam.

import type { EntityId } from '../ids.js';
import { noBlocked } from './seams.js';
import type { Blocked, PhysicsSink } from './seams.js';
import type { SimTransformStore } from '../world/transform-store.js';

export class NullPhysicsSink implements PhysicsSink {
    readonly #transforms: SimTransformStore;

    constructor(transforms: SimTransformStore) {
        this.#transforms = transforms;
    }

    move(
        id: EntityId,
        dt: number,
        velocity: Readonly<{ x: number; y: number; z: number }>,
    ): Blocked {
        const x = this.#transforms.posX(id) + velocity.x * dt;
        const y = this.#transforms.posY(id) + velocity.y * dt;
        const z = this.#transforms.posZ(id) + velocity.z * dt;
        this.#transforms.setPosition(id, x, y, z);
        return noBlocked();
    }
}

// The null PhysicsSink (DESIGN §10, §2). Integrates position and sets `blocked` all-false:
// "A platformer runs and falls; it does not land." Rapier fills the same seam later.

import type { EntityId } from '../ids.js';
import { noBlocked } from './seams.js';
import type { Blocked, PhysicsSink } from './seams.js';
import type { SimTransformStore } from '../world/transform-store.js';

export class NullPhysicsSink implements PhysicsSink {
    readonly #transforms: SimTransformStore;

    constructor(transforms: SimTransformStore) {
        this.#transforms = transforms;
    }

    move(id: EntityId, dt: number, velocity: Readonly<{ x: number; y: number; z: number }>): Blocked {
        // No contact resolution: integrate position from velocity and report nothing blocked.
        const x = this.#transforms.posX(id) + velocity.x * dt;
        const y = this.#transforms.posY(id) + velocity.y * dt;
        const z = this.#transforms.posZ(id) + velocity.z * dt;
        this.#transforms.setPosition(id, x, y, z);
        return noBlocked();
    }
}

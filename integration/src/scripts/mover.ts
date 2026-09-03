// The avatar's movement, and the one script both ends run.
//
// `SyncedScript` runs on a server AND on a client, which is what makes it the only kind prediction
// can replay — a `ServerScript` is filtered out of a client tick and never dispatched to.

import type { Entity } from '@platform/engine';
import { SyncedScript, clamp, onEventHold } from '@platform/engine';
import {
    ACTION_DOWN,
    ACTION_LEFT,
    ACTION_RIGHT,
    ACTION_UP,
    AVATAR_HALF,
    AVATAR_STEP,
    WORLD,
} from '../globals.js';

export class Mover extends SyncedScript<Entity> {
    /** Configured on the template attachment, so both ends replay the same number. */
    step = AVATAR_STEP;

    @onEventHold(ACTION_LEFT)
    left(): void {
        this.#moveBy(-this.step, 0);
    }

    @onEventHold(ACTION_RIGHT)
    right(): void {
        this.#moveBy(this.step, 0);
    }

    @onEventHold(ACTION_UP)
    up(): void {
        this.#moveBy(0, this.step);
    }

    @onEventHold(ACTION_DOWN)
    down(): void {
        this.#moveBy(0, -this.step);
    }

    /** The clamp is part of the simulation both ends replay, not a display courtesy. */
    #moveBy(dx: number, dy: number): void {
        const at = this.host.position;
        this.host.setPosition(
            clamp(at.x + dx, WORLD.left + AVATAR_HALF, WORLD.right - AVATAR_HALF),
            clamp(at.y + dy, WORLD.bottom + AVATAR_HALF, WORLD.top - AVATAR_HALF),
        );
    }
}

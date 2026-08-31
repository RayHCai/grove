// The `player` template's movement, and the one script both ends run.
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
} from '../../globals.js';

/**
 * Moves the avatar a fixed step per held tick, on both axes.
 *
 * A constant rather than a speed integrated over `dt`: both ends run at the session's `simRate`, so
 * the two arrive at the same number without a rounding argument.
 */
export class Runner extends SyncedScript<Entity> {
    /**
     * World units one held tick moves the avatar, configured on the template attachment.
     *
     * Still defaults, because an attachment carrying no props must move at the same speed rather
     * than by `NaN`.
     */
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

    #moveBy(dx: number, dy: number): void {
        const host = this.host;
        const at = host.position;
        // Clamped rather than free: an avatar walked off the stage is gone for good, and the clamp
        // is part of the simulation both ends replay. The vertical clamp keeps the whole body on the
        // stage, so a leaf at the extreme of the drop band is still reachable.
        host.setPosition(
            clamp(at.x + dx, WORLD.left, WORLD.right),
            clamp(at.y + dy, WORLD.bottom + AVATAR_HALF, WORLD.top - AVATAR_HALF),
        );
    }
}

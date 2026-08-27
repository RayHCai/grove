// The one script both ends run.
//
// `SyncedScript` is the location that runs on a server AND on a client, which is what makes it the only
// kind prediction can replay: a `ServerScript` is filtered out of a client tick and would never be
// dispatched to. The authority simulates this on the tick it receives the input; the client simulates it
// on the tick it SENDS the input, and rewinds to whatever the authority then says.
//
// It is a separate project directory because of how it is compiled, not because of where it runs: `tsc`
// is the only tool here that lowers standard decorators, so the browser imports the emitted `dist/`
// copy rather than this source.

import { SyncedScript, onEventHold } from '@platform/core';
import type { Entity } from '@platform/core';
import { clamp } from '@platform/math';
import {
    ACTION_DOWN,
    ACTION_LEFT,
    ACTION_RIGHT,
    ACTION_UP,
    AVATAR_HALF,
    AVATAR_STEP,
    WORLD,
} from '../shared.js';

/**
 * Moves the avatar a fixed step per held tick, on both axes.
 *
 * A constant rather than a speed integrated over `dt`: both ends run at the session's `simRate` and a
 * held tick is a held tick, so the two arrive at the same number without a rounding argument. Two keys
 * held at once each dispatch their own `hold`, so a diagonal is the two steps taken in sequence.
 */
export class Runner extends SyncedScript<Entity> {
    /**
     * World units one held tick moves the avatar, configured on the template attachment.
     *
     * The props ride the `attach` op, so the browser is told this number rather than reading a
     * constant of its own — but it still defaults, because an attachment that carries none must
     * move at the same speed rather than by `NaN`.
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
        // Clamped rather than free: an avatar walked off the stage is gone for good, and the clamp is
        // part of the simulation both ends replay. The vertical clamp keeps the whole body on the
        // stage, so a leaf at the extreme of the drop band is still reachable.
        host.setPosition(
            clamp(at.x + dx, WORLD.left, WORLD.right),
            clamp(at.y + dy, WORLD.bottom + AVATAR_HALF, WORLD.top - AVATAR_HALF),
        );
    }
}

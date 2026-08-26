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
import { ACTION_LEFT, ACTION_RIGHT, AVATAR_STEP, WORLD } from '../shared.js';

/**
 * Moves the avatar a fixed step per held tick.
 *
 * A constant rather than a speed integrated over `dt`: both ends run at the session's `simRate` and a
 * held tick is a held tick, so the two arrive at the same number without a rounding argument.
 */
export class Runner extends SyncedScript<Entity> {
    @onEventHold(ACTION_LEFT)
    left(): void {
        this.#moveBy(-AVATAR_STEP);
    }

    @onEventHold(ACTION_RIGHT)
    right(): void {
        this.#moveBy(AVATAR_STEP);
    }

    #moveBy(dx: number): void {
        const host = this.host;
        // Clamped rather than free: an avatar walked off the stage is gone for good, and the clamp is
        // part of the simulation both ends replay.
        host.setPosition(clamp(host.position.x + dx, WORLD.left, WORLD.right), host.position.y);
    }
}

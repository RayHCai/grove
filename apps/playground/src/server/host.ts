// This game's world, built and granted its one capability — but not listening.
//
// `main.ts` puts a socket in front of what this returns; the session suite drives it directly over
// a loopback pair. Both need the same three things done in the same order, and this is the only
// place that knows them: reset the module state a previous world published, boot, then grant.

import type { BreakerTrip, KVStore } from '@platform/core';
import { defined } from '@platform/math';
import { GameInstance } from '@platform/glue/server';
import { PROJECT } from '../project.js';
import { onCrownNeeded, resetSession } from '../scripts/session.js';
import { SERVER_SCRIPTS } from './registry.js';
import { CROWN_VISUALS } from './visuals.js';

export interface HostOptions {
    /** Where `@serverState` outlives a session. Omitted, core's memory store dies with the process. */
    kv?: KVStore;
    /** The loopback pair's `deliver`; omitted networked, where each socket delivers itself. */
    deliver?: () => void;
    /** Wall-clock seconds. Omitted, the real clock — the suite turns its own by hand. */
    now?: () => number;
    /** The dev channel for a handler the breaker gave up on. Not an envelope, deliberately. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
}

/**
 * Boots this project. It accepts nothing and starts no clock — `listenOn` or the suite does both.
 *
 * The grant happens after construction because the Game's `@onStart` has already run by then, and
 * before anything is accepted because a capability the game asks for mid-round must already be there.
 */
export function createGameInstance(opts: HostOptions = {}): GameInstance {
    // A second world in one process must not inherit the first's published match.
    resetSession();
    const instance = new GameInstance({
        project: PROJECT,
        scripts: SERVER_SCRIPTS,
        ...defined({
            kv: opts.kv,
            deliver: opts.deliver,
            now: opts.now,
            onBreakerTrip: opts.onBreakerTrip,
        }),
    });
    onCrownNeeded(() => instance.server.declareVisuals(CROWN_VISUALS));
    return instance;
}

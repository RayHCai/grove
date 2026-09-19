// Reset the module state a previous world published, boot, then grant — in that order.
// `main.ts` puts a socket in front of this; the session suite drives it over a loopback pair.

import type { BreakerTrip, KVStore } from '@platform/core';
import { defined } from '@platform/math';
import { GameInstance } from '@platform/glue/server';
import { PROJECT } from '../project.js';
import { onCrownNeeded, resetSession } from '../scripts/session.js';
import { SERVER_SCRIPTS } from './registry.js';
import { CROWN_VISUALS } from './visuals.js';

export interface HostOptions {
    /** Where `@serverState` outlives a session. Omitted, core's memory store dies with it. */
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
 * The grant lands after construction, since the Game's `@onStart` has run, and before any accept.
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
    onCrownNeeded(() => instance.declareVisuals(CROWN_VISUALS));
    return instance;
}

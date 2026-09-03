// This game's world, built but not listening.
//
// A socket host would put a listener in front of what this returns; the suite drives it directly
// over loopback pairs. Both need the same thing built the same way, and this is the only place
// that knows how.

import type { BreakerTrip, KVStore } from '@platform/core';
import { GameInstance } from '@platform/glue/server';
import { defined } from '@platform/math';
import type { World } from './world.js';

export interface HostOptions {
    /** Where `@serverState` outlives a session. Omitted, core's memory store dies with the process. */
    kv?: KVStore;
    /** The loopback pairs' `deliver`; omitted networked, where each socket delivers itself. */
    deliver?: () => void;
    /** Wall-clock seconds. Omitted, the real clock — the suite turns its own by hand. */
    now?: () => number;
    /** The dev channel for a handler the breaker gave up on. Not an envelope, deliberately. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
}

export function createGameInstance(world: World, opts: HostOptions = {}): GameInstance {
    return new GameInstance({
        project: world.project,
        scripts: world.server,
        ...defined({
            kv: opts.kv,
            deliver: opts.deliver,
            now: opts.now,
            onBreakerTrip: opts.onBreakerTrip,
        }),
    });
}

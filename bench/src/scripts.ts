// The script fixtures a sweep multiplies. Decorated, so they are compiled by `tsc` and imported
// from `dist` like every other decorated class in this repo.

import { SyncedScript, onCollide, onUpdate, serverState } from '@platform/core';
import type { Entity } from '@platform/core';

/** The cheapest possible `@onUpdate`: what a script-count sweep prices is the dispatch, not the body. */
export class BenchTicker extends SyncedScript<Entity> {
    ticks = 0;

    @onUpdate
    tick(): void {
        this.ticks += 1;
    }
}

/** An `@onUpdate` that dirties a replicated field, so a sweep can price the state channel too. */
export class BenchWriter extends SyncedScript<Entity> {
    @serverState counter = 0;

    @onUpdate
    tick(): void {
        this.counter += 1;
    }
}

/** A contact handler, so a world with overlapping bodies dispatches rather than only walking pairs. */
export class BenchCollider extends SyncedScript<Entity> {
    hits = 0;

    @onCollide('bench')
    touched(): void {
        this.hits += 1;
    }
}

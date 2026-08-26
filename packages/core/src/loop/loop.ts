// Core owns no clock: `step` adopts the tick index it is handed rather than incrementing, and
// `dt` is always 1/simRate and never measured, so server and client tick identically.

import type { EntityId } from '../ids.js';
import type { Scope, Snapshot } from './store-registry.js';
import type { Runtime } from '../runtime/runtime.js';
import { withRuntime } from '../runtime/runtime.js';
import { entityKey } from '../runtime/hosts.js';
import type { DispatchOptions } from '../dispatch/dispatcher.js';
import { activeLocationsFor } from '../runtime/wiring.js';

export interface StepOptions {
    /** Suppress one-shot effects on a replayed tick. */
    replay?: boolean;
    /** The simulated set on the client's hot path; whole world when omitted. */
    scope?: ReadonlySet<EntityId>;
}

export class Loop {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    /** Executes exactly one tick at index `tick`. The host owns the accumulator that calls this. */
    step(tick: number, opts: StepOptions = {}): void {
        // The passes and the facades they reach resolve the ambient runtime, so a tick must
        // establish it or a second live runtime silently receives the writes.
        withRuntime(this.#rt, () => this.#tick(tick, opts));
    }

    #tick(tick: number, opts: StepOptions): void {
        this.#rt.tick = tick;

        const active = activeLocationsFor(this.#rt.isServer ? 'server' : 'client');
        const dispatch: DispatchOptions = {
            activeLocations: active,
            replay: opts.replay ?? false,
            tick,
        };
        const dt = 1 / this.#rt.simRate;

        const passes = this.#rt.passes;

        // Pass order is part of the simulation contract; reordering changes results.
        passes?.input(dispatch);

        passes?.movement(dt, opts.scope);

        passes?.contacts(dispatch);

        passes?.regions(dispatch);

        this.#rt.timers.advance();
        this.#rt.tweens.advance();
        passes?.countdowns(dispatch);

        passes?.update(dispatch, dt, opts.scope);

        this.#rt.entityManager.drainDestroyed();

        if (this.#rt.isServer) this.#rt.lagRing?.capture(tick);
    }

    /** Captures every registered store at the current tick, scoped or whole. */
    snapshot(scope: Scope = null): Snapshot {
        return this.#rt.registry.snapshot(this.#rt.tick, scope);
    }

    /** Restores a snapshot and kills invocations newer than its tick, freeing their locks. */
    restore(snapshot: Snapshot): void {
        this.#rt.registry.restore(snapshot);
        this.#rt.tick = snapshot.tick;
        this.#rt.scopes.sweepAfterTick(snapshot.tick);
    }
}

export { entityKey };

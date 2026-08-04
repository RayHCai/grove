// The loop (DESIGN §8.1, §8.2). `step(tick, opts)` is the primitive: execute one tick at an
// explicit index, no clock. `advance(elapsed)` is a fixed-step accumulator over step. Tick
// order is spec and tested (§8.2). snapshot/restore live here over the store registry; a
// rewind sweeps parked invocations newer than the target tick (§8.1).

import type { EntityId } from '../ids.js';
import type { Scope, Snapshot } from './store-registry.js';
import type { Runtime } from '../runtime/runtime.js';
import { entityKey } from '../runtime/hosts.js';
import type { DispatchOptions } from '../dispatch/dispatcher.js';
import { activeLocationsFor } from '../runtime/wiring.js';

export interface StepOptions {
    /** Suppress one-shot effects on a replayed tick (§8.1). */
    replay?: boolean;
    /** The simulated set on the client's hot path; whole world when omitted (§8.1). */
    scope?: ReadonlySet<EntityId>;
}

export class Loop {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    /** Execute exactly one tick at index `tick`. The primitive — no clock (§8.1). */
    step(tick: number, opts: StepOptions = {}): void {
        this.#rt.tick = tick; // 1: adopt, NOT increment (§8.2)

        const active = activeLocationsFor(this.#rt.isServer ? 'server' : 'client');
        const dispatch: DispatchOptions = { activeLocations: active, replay: opts.replay ?? false, tick };
        const dt = 1 / this.#rt.simRate; // always 1/simRate, never measured (§8.1)

        const passes = this.#rt.passes;

        // 2-3: input apply + dispatch — input source drives @onEvent; scripted in tests.
        passes?.input(dispatch);

        // 4: movement tick, per avatar (before @onUpdate, §8.2)
        passes?.movement(dt, opts.scope);

        // 5: contacts — resolve the set; dispatch @onCollide/@onEnter/@onExit
        passes?.contacts(dispatch);

        // 6: regions — point-in-region enter/exit; checkpoints
        passes?.regions(dispatch);

        // 7: timers & tweens, motion verbs, Countdown
        this.#rt.timers.advance();
        this.#rt.tweens.advance();
        passes?.countdowns();

        // 8: @onUpdate at simRate (SyncedScript + ServerScript)
        passes?.update(dispatch, dt, opts.scope);

        // 9: destroy drain — teardown deferred in §6
        this.#rt.entityManager.drainDestroyed();

        // 10: replicate — the sink decides cadence; the ring captures on the server (§8.1)
        if (this.#rt.isServer) this.#rt.lagRing?.capture(tick);
    }

    /** A fixed-step accumulator over step (§8.1). Ordinary hosting. */
    advance(elapsedSeconds: number): void {
        this.#accumulator += elapsedSeconds;
        const dt = 1 / this.#rt.simRate;
        while (this.#accumulator >= dt) {
            if (!this.#rt.paused) this.step(this.#rt.tick + 1, { replay: false });
            this.#accumulator -= dt;
        }
    }

    #accumulator = 0;

    // ── snapshot / restore (§8.1) ────────────────────────────────────────────────

    /** Capture every registered store at the current tick, scoped or whole. */
    snapshot(scope: Scope = null): Snapshot {
        return this.#rt.registry.snapshot(this.#rt.tick, scope);
    }

    /**
     * Restore to a snapshot and sweep every invocation newer than its tick (§8.1): a parked
     * async handler from a timeline that did not happen is marked dead, releasing its
     * concurrency lock and scope-tree entry so its continuation is unreachable.
     */
    restore(snapshot: Snapshot): void {
        this.#rt.registry.restore(snapshot);
        this.#rt.tick = snapshot.tick;
        this.#rt.scopes.sweepAfterTick(snapshot.tick);
    }
}

export { entityKey };

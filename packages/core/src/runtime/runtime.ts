// The Runtime is the swappable slot the ambient consts (game, hud, random, assets) are
// facades over (DESIGN §8.4). It holds every store — each registered with the
// StoreRegistry so snapshot() iterates them (§8.1) — the scope tree, the replication
// channels, the dispatcher, the seams, and the tick counter.
//
// createRuntime() builds an isolated world; withRuntime(rt, fn) runs fn against it. This
// is what makes the spec's module-const surface testable and multi-instance-per-process.

import { DEFAULT_SIM_RATE } from '../config.js';
import { ScopeTree } from '../dispatch/scope-tree.js';
import { BreakerCounters } from '../dispatch/breaker.js';
import { StoreRegistry } from '../loop/store-registry.js';
import { TimerHeap } from '../loop/timers.js';
import { TweenEngine } from '../loop/tweens.js';
import { EntityTable } from '../world/entity-table.js';
import { SimTransformStore } from '../world/transform-store.js';
import { TagIndex } from '../world/tag-index.js';
import { ReplicationChannels } from '../state/channels.js';
import { PRNGStore } from './prng-store.js';
import { ManualClock, MemoryKVStore, NullEffectSink } from './seams.js';
import type { Clock, EffectSink, KVStore, PhysicsSink } from './seams.js';
import { NullPhysicsSink } from './physics.js';

/** Everything one game world owns. */
export class Runtime {
    readonly registry = new StoreRegistry();

    readonly entities = new EntityTable();
    readonly transforms = new SimTransformStore();
    readonly tags = new TagIndex();
    readonly prng = new PRNGStore();
    readonly breaker = new BreakerCounters();
    readonly timers = new TimerHeap();
    readonly tweens = new TweenEngine();

    readonly scopes = new ScopeTree();
    readonly channels = new ReplicationChannels();

    // Seams — null implementations by default (§10); a host swaps them in.
    clock: Clock = new ManualClock();
    physics: PhysicsSink = new NullPhysicsSink(this.transforms);
    kv: KVStore = new MemoryKVStore();
    effects: EffectSink = new NullEffectSink();

    simRate = DEFAULT_SIM_RATE;

    /** Monotonic tick counter from 0; engine-internal (§8.1). The `step` argument, not this. */
    tick = 0;

    /** Whether this runtime is the authoritative server (retains the lag ring). */
    isServer = true;

    constructor() {
        // Registration order is capture/apply order; derived stores register last (§8.1).
        this.registry.register(this.entities);
        this.registry.register(this.transforms);
        this.registry.register(this.tags);
        this.registry.register(this.prng);
        this.registry.register(this.breaker);
        this.registry.register(this.timers);

        this.timers.setSimRate(this.simRate);
        this.tweens.setSimRate(this.simRate);
    }

    setSimRate(rate: number): void {
        this.simRate = rate;
        this.timers.setSimRate(rate);
        this.tweens.setSimRate(rate);
    }
}

let current: Runtime | null = null;

/** Builds an isolated runtime and makes it current. */
export function createRuntime(): Runtime {
    current = new Runtime();
    return current;
}

/** The current runtime. Throws if none is active — a facade read before loadGame. */
export function currentRuntime(): Runtime {
    if (current === null) {
        throw new Error('no active runtime — call createRuntime() or loadGame() first');
    }
    return current;
}

/** True when a runtime is active, so a facade can decide whether to no-op. */
export function hasRuntime(): boolean {
    return current !== null;
}

/** Runs `fn` with `rt` as the current runtime, restoring the previous slot after. */
export function withRuntime<T>(rt: Runtime, fn: () => T): T {
    const prev = current;
    current = rt;
    try {
        return fn();
    } finally {
        current = prev;
    }
}

/** Clears the current runtime — for test teardown. */
export function clearRuntime(): void {
    current = null;
}

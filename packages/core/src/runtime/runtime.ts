// The Runtime is the swappable slot the ambient consts (game, hud, random, assets) are
// facades over (DESIGN §8.4). It holds every store — each registered with the
// StoreRegistry so snapshot() iterates them (§8.1) — the scope tree, the host table, the
// replication channels, the dispatcher, the seams, and the tick counter.
//
// createRuntime() builds an isolated world; withRuntime(rt, fn) runs fn against it. This
// is what makes the spec's module-const surface testable and multi-instance-per-process.

import { DEFAULT_SIM_RATE } from '../config.js';
import { ScopeTree } from '../dispatch/scope-tree.js';
import { BreakerCounters } from '../dispatch/breaker.js';
import { Dispatcher } from '../dispatch/dispatcher.js';
import type { DispatchLog } from '../dispatch/dispatcher.js';
import { InstanceRegistry } from '../dispatch/instances.js';
import { StoreRegistry } from '../loop/store-registry.js';
import { TimerHeap } from '../loop/timers.js';
import { TweenEngine } from '../loop/tweens.js';
import { EntityTable } from '../world/entity-table.js';
import { SimTransformStore } from '../world/transform-store.js';
import { TagIndex } from '../world/tag-index.js';
import { EntityManager } from '../world/entity-manager.js';
import { ReplicationChannels } from '../state/channels.js';
import type { HandlerErrorRecord } from '../errors.js';
import { HostTable } from './hosts.js';
import { PRNGStore } from './prng-store.js';
import { ManualClock, MemoryKVStore, NullEffectSink } from './seams.js';
import type { Clock, EffectSink, KVStore, PhysicsSink } from './seams.js';
import { NullPhysicsSink } from './physics.js';

import type { DispatchOptions } from '../dispatch/dispatcher.js';
import type { EntityId } from '../ids.js';
import type { Bounds } from '@platform/math';
import type { Broadphase } from '../world/broadphase.js';
import type { PlayerManager, Player } from './player.js';
import type { ContactSource } from './contacts.js';
import type { Wiring } from './wiring.js';
import type { LagRing } from './lag-ring.js';
import type { Roster } from './roster.js';
import type { Camera } from './camera.js';
import type { Storage } from './wrappers.js';
import type { Random } from './random.js';
import type { Game, WorldQuery } from './game.js';
import type { RegionIndex } from './regions.js';

/** The per-tick passes the loop drives, in tick order (§8.2). Wired by loadGame. */
export interface TickPasses {
    input(dispatch: DispatchOptions): void;
    movement(dt: number, scope: ReadonlySet<EntityId> | undefined): void;
    contacts(dispatch: DispatchOptions): void;
    regions(dispatch: DispatchOptions): void;
    countdowns(): void;
    update(dispatch: DispatchOptions, dt: number, scope: ReadonlySet<EntityId> | undefined): void;
}

/** A logged handler throw or engine warning (§4.4, §14). Console by default. */
export interface EngineLog extends DispatchLog {
    warn(message: string): void;
    readonly records: ReadonlyArray<HandlerErrorRecord & { phase?: string; disabled?: boolean }>;
}

/** Default log: collects records and mirrors them to the console. */
export class CollectingLog implements EngineLog {
    readonly #records: Array<HandlerErrorRecord & { phase?: string; disabled?: boolean }> = [];

    error(record: HandlerErrorRecord & { phase?: string; disabled?: boolean }): void {
        this.#records.push(record);
    }

    warn(_message: string): void {
        // Engine warnings go to the dev console in a real host (§14.3); collected here.
    }

    get records(): ReadonlyArray<HandlerErrorRecord & { phase?: string; disabled?: boolean }> {
        return this.#records;
    }
}

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
    readonly hosts = new HostTable(this.scopes);
    readonly channels = new ReplicationChannels();
    readonly instances = new InstanceRegistry();
    readonly log: EngineLog = new CollectingLog();
    readonly dispatcher = new Dispatcher(this.scopes, this.breaker, this.log);
    readonly entityManager = new EntityManager(this);

    // Seams — null implementations by default (§10); a host swaps them in.
    clock: Clock = new ManualClock();
    physics: PhysicsSink = new NullPhysicsSink(this.transforms);
    kv: KVStore = new MemoryKVStore();
    effects: EffectSink = new NullEffectSink();

    simRate = DEFAULT_SIM_RATE;

    /** Monotonic tick counter from 0; engine-internal (§8.1). The `step` argument, not this. */
    tick = 0;

    /** Whether this runtime is authoritative (server retains the lag ring). */
    isServer = true;

    // Collaborators wired during loadGame — optional so the Runtime is constructible bare
    // for a pure-store test. Each is set once by the wiring step (§8.3).
    playerManager?: PlayerManager;
    contacts?: ContactSource;
    wiring?: Wiring;
    lagRing?: LagRing;
    roster?: Roster;
    /** send(entityId, event, payload) via the dispatcher; set by wiring. */
    send?: (id: EntityId, event: string, payload?: Record<string, unknown>) => Promise<void>;
    /** Camera/Storage factories, per-player; set by wiring so the facade needn't import them. */
    makeCamera?: (player: Player) => Camera;
    makeStorage?: (player: Player) => Storage;
    /** The local player on a client runtime; undefined on the server ("local" names nothing). */
    localPlayer?: Player | null;
    /** Persisted @serverState from a previous session, keyed by (hostId, field) (§5.3). */
    persisted?: { get(hostId: string, field: string): unknown };
    /** Client→server request delivery; set by wiring in loopback, by transport over a network. */
    requestSink?: (name: string, payload?: Record<string, unknown>) => void;
    /** The seeded random facade (§8.4). */
    random?: Random;
    /** The one Game instance (§7). */
    gameInstance?: Game;
    /** The FindQuery resolver. */
    query?: WorldQuery;
    /** The live Broadphase over the transform store (§2). */
    broadphase?: Broadphase;
    /** The panel-authored region index (§8.2). */
    regions?: RegionIndex;
    /** Build-time world extent, readonly once loaded (§7). */
    worldBounds?: Bounds;
    /** The per-tick passes the loop drives; set by loadGame (§8.2). */
    passes?: TickPasses;
    /** Local-mode pause gate (§7). */
    paused = false;

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
        this.timers.setScopeOwnerLookup(scopeId => this.#entityForScope(scopeId));
    }

    setSimRate(rate: number): void {
        this.simRate = rate;
        this.timers.setSimRate(rate);
        this.tweens.setSimRate(rate);
    }

    /** Reverse lookup used by the timer heap's scoped snapshot filter. */
    #entityForScope(scopeId: number): number {
        for (let i = 0; i < this.entities.slotCount; i++) {
            const id = this.entities.idAt(i as never) as unknown as number;
            if (id === 0) continue;
            if (this.hosts.scopeForEntity(id) === scopeId) return id % 0x100_0000;
        }
        return -1;
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

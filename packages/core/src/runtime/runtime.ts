// The Runtime is the swappable world the ambient consts (game, random, assets) are facades
// over, which is what makes that module-const surface testable and multi-instance-per-process.

import { DEFAULT_SIM_RATE, MAX_LOG_RECORDS } from '../config.js';
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
import { ENTITY_KEY_PREFIX, HostTable } from './hosts.js';
import { PRNGStore } from './prng-store.js';
import { ManualClock, MemoryKVStore, NullEffectSink } from './seams.js';
import type { Clock, EffectSink, KVStore, PhysicsSink } from './seams.js';
import { NullPhysicsSink } from './physics.js';

import type { DispatchOptions } from '../dispatch/dispatcher.js';
import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
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
import type { Assets } from './assets.js';
import type { Game, WorldQuery } from './game.js';
import type { RegionIndex } from './regions.js';

/** The per-tick passes the loop drives, in tick order. */
export interface TickPasses {
    input(dispatch: DispatchOptions): void;
    movement(dt: number, scope: ReadonlySet<EntityId> | undefined): void;
    contacts(dispatch: DispatchOptions): void;
    regions(dispatch: DispatchOptions): void;
    countdowns(): void;
    update(dispatch: DispatchOptions, dt: number, scope: ReadonlySet<EntityId> | undefined): void;
}

/** A logged handler throw or engine warning. */
export interface EngineLog extends DispatchLog {
    warn(message: string): void;
    readonly records: ReadonlyArray<HandlerErrorRecord & { phase?: string; disabled?: boolean }>;
}

/** Default log: retains the most recent MAX_LOG_RECORDS error records in memory. */
export class CollectingLog implements EngineLog {
    readonly #records: Array<HandlerErrorRecord & { phase?: string; disabled?: boolean }> = [];

    error(record: HandlerErrorRecord & { phase?: string; disabled?: boolean }): void {
        // Capped: a session runs for hours and an unbounded array is a slow leak that only shows
        // up on the machine already having a bad day.
        if (this.#records.length >= MAX_LOG_RECORDS) {
            this.#records.shift();
        }
        this.#records.push(record);
    }

    warn(_message: string): void {
        // Warnings belong in the host's dev console, not in the error records.
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

    // Null implementations by default, so every member is exercisable in Node.
    clock: Clock = new ManualClock();
    physics: PhysicsSink = new NullPhysicsSink(this.transforms);
    kv: KVStore = new MemoryKVStore();
    effects: EffectSink = new NullEffectSink();

    simRate = DEFAULT_SIM_RATE;

    /** The tick the loop last adopted; step() assigns its argument rather than incrementing. */
    tick = 0;

    /** Whether this runtime is authoritative; only a server captures the lag ring. */
    isServer = true;

    // Optional so a store-level test can construct a Runtime bare; loadGame fills them in.
    playerManager?: PlayerManager;
    contacts?: ContactSource;
    wiring?: Wiring;
    lagRing?: LagRing;
    roster?: Roster;
    send?: (id: EntityId, event: string, payload?: Record<string, unknown>) => Promise<void>;
    /** Injected so the player facade need not import Camera and Storage. */
    makeCamera?: (player: Player) => Camera;
    makeStorage?: (player: Player) => Storage;
    /** The local player on a client runtime; undefined on the server. */
    localPlayer?: Player | null;
    /** Persisted @serverState from a previous session, keyed by (hostId, field). */
    persisted?: { get(hostId: string, field: string): unknown };
    /** Client→server request delivery; loadGame installs the loopback sink. */
    requestSink?: (name: string, payload?: Record<string, unknown>) => void;
    random?: Random;
    /** The manifest's asset table; the `assets` const resolves through here. */
    assets?: Assets;
    gameInstance?: Game;
    query?: WorldQuery;
    /** Broadphase over the live transform store, never a lag-ring buffer. */
    broadphase?: Broadphase;
    regions?: RegionIndex;
    worldBounds?: Bounds;
    passes?: TickPasses;
    /** For the host's accumulator to honour; `step` runs a tick regardless. */
    paused = false;

    constructor() {
        // Registration order is capture and apply order.
        this.registry.register(this.entities);
        this.registry.register(this.transforms);
        this.registry.register(this.tags);
        this.registry.register(this.prng);
        this.registry.register(this.breaker);
        this.registry.register(this.timers);

        this.timers.setSimRate(this.simRate);
        this.tweens.setSimRate(this.simRate);
        this.timers.setScopeOwnerLookup((scopeId) => this.#entityForScope(scopeId));
    }

    setSimRate(rate: number): void {
        this.simRate = rate;
        this.timers.setSimRate(rate);
        this.tweens.setSimRate(rate);
    }

    // Through the host table's reverse index: a scan of every slot per pending timer put a scoped
    // snapshot — which the client takes every frame — well past a whole frame's budget.
    #entityForScope(scopeId: number): number {
        const key = this.hosts.keyForScope(scopeId);
        if (key === undefined || !key.startsWith(ENTITY_KEY_PREFIX)) return -1;
        const id = Number(key.slice(ENTITY_KEY_PREFIX.length));
        return Number.isSafeInteger(id) ? entityIndex(id as EntityId) : -1;
    }
}

let current: Runtime | null = null;

/** Builds an isolated runtime and makes it current. */
export function createRuntime(): Runtime {
    current = new Runtime();
    return current;
}

/** The current runtime; throws if none is active. */
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

// The Runtime is the swappable world the ambient consts (game, random, assets) are facades
// over, which is what makes that module-const surface testable and multi-instance-per-process.

import { DEFAULT_SIM_RATE, MAX_LOG_RECORDS } from '../config.js';
import { ScopeTree } from '../dispatch/scope-tree.js';
import type { GuardOwner } from '../dispatch/scope-tree.js';
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
import { ManualClock, MemoryKVStore, NullEffectSink, NullHUDSink } from './seams.js';
import type { Clock, EffectSink, HUDSink, KVStore, PhysicsSink } from './seams.js';
import { NullPhysicsSink } from './physics.js';

import type { DispatchOptions } from '../dispatch/dispatcher.js';
import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
import type { Bounds } from '@platform/math';
import type { ScriptId } from '@platform/project';
import type { Broadphase } from '../world/broadphase.js';
import type { TemplateRegistry } from '../world/templates.js';
import type { PlayerManager, Player } from './player.js';
import type { ContactSource } from './contacts.js';
import type { Wiring } from './wiring.js';
import type { LagRing } from './lag-ring.js';
import type { Roster } from './roster.js';
import type { Camera } from './camera.js';
import type { Countdown, Storage } from './wrappers.js';
import type { PersistedSource } from './persistence.js';
import type { Random } from './random.js';
import type { Assets } from './assets.js';
import type { Game, WorldQuery } from './game.js';
import type { RegionIndex } from './regions.js';
import type { HUDState } from './hud.js';

/** The per-tick passes the loop drives, in tick order. */
export interface TickPasses {
    /**
     * `@onStart` for everything attached since the last tick — first, so a script is running before
     * anything can dispatch to it, and after the previous tick's destroy drain, so one attached to
     * an entity that then died never starts at all.
     */
    starts(dispatch: DispatchOptions): void;
    input(dispatch: DispatchOptions): void;
    movement(dt: number, scope: ReadonlySet<EntityId> | undefined): void;
    contacts(dispatch: DispatchOptions): void;
    regions(dispatch: DispatchOptions): void;
    /** Takes the dispatch options for `replay` alone: a re-run tick must not spend a countdown twice. */
    countdowns(dispatch: DispatchOptions): void;
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
    /** The running countdowns the countdowns pass advances; a Countdown enrols itself on `start`. */
    readonly countdowns = new Set<Countdown>();

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
    hudSink: HUDSink = new NullHUDSink();

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
    persisted?: PersistedSource;
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
    /** What a spawn key means; a key it does not hold spawns one bare entity. */
    templates?: TemplateRegistry;
    /**
     * The id the bundle stamped on a class, for the `attach` op that names it on the wire.
     *
     * A function rather than the registry itself: core mints no ids and must not import the package
     * that builds one, which imports core.
     */
    scriptIdOf?: (klass: abstract new (...args: never[]) => object) => ScriptId | undefined;
    /** The screens and widgets the `hud` const is a facade over; one per world, built by loadGame. */
    hud?: HUDState;
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
        // The heaps fire creator callbacks from inside a tick, so they run under the dispatcher's
        // boundary or a throw escapes the loop and ends the session.
        this.timers.setGuard((owner, method, fn) =>
            this.guardCallback(owner, method, '@timer', fn),
        );
        this.tweens.setGuard((owner, method, fn) =>
            this.guardCallback(owner, method, '@tween', fn),
        );
    }

    /** Runs a creator callback that reaches the engine outside a handler under that same boundary. */
    guardCallback(owner: GuardOwner | null, method: string, event: string, fn: () => void): void {
        const hostId = owner === null ? '' : (this.hosts.keyForScope(owner.hostScopeId) ?? '');
        this.dispatcher.guard(owner, { method, hostId, tick: this.tick, event }, fn);
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

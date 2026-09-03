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
import { LoadError } from '../errors.js';
import { entityIdOfKey, HostTable } from './hosts.js';
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

/**
 * The collaborators `loadGame` builds, installed as one object so no facade can see half a world.
 *
 * Separate from the stores the constructor makes because a store-level test builds a `Runtime` with
 * no world behind it, and reaching one of these there is a mistake worth a message.
 */
export interface Wired {
    readonly playerManager: PlayerManager;
    readonly contacts: ContactSource;
    readonly wiring: Wiring;
    readonly lagRing: LagRing;
    readonly roster: Roster;
    readonly send: (
        id: EntityId,
        event: string,
        payload?: Record<string, unknown>,
    ) => Promise<void>;
    /** Injected so the player facade need not import Camera and Storage. */
    readonly makeCamera: (player: Player) => Camera;
    readonly makeStorage: (player: Player) => Storage;
    /** Client→server request delivery; loadGame installs the loopback sink. */
    readonly requestSink: (name: string, payload?: Record<string, unknown>) => void;
    readonly random: Random;
    /** The manifest's asset table; the `assets` const resolves through here. */
    readonly assets: Assets;
    readonly gameInstance: Game;
    readonly query: WorldQuery;
    /** Broadphase over the live transform store, never a lag-ring buffer. */
    readonly broadphase: Broadphase;
    readonly regions: RegionIndex;
    /** What a spawn key means; a key it does not hold spawns one bare entity. */
    readonly templates: TemplateRegistry;
    /** The screens and widgets the `hud` const is a facade over; one per world. */
    readonly hud: HUDState;
    /** Mutable: an endpoint swaps the pass table as prediction starts and stops. */
    passes: TickPasses;
}

/** A logged handler throw or engine warning. */
export interface EngineLog extends DispatchLog {
    warn(message: string): void;
    readonly records: ReadonlyArray<HandlerErrorRecord & { phase?: string; disabled?: boolean }>;
}

/**
 * Where the engine's diagnostics leave core, installed through `LoadOptions.log`.
 *
 * Core writes to a console nowhere and holds no transport, so a warning has nowhere to go without
 * one of these: everything the host is meant to see about a misbehaving world arrives here.
 */
export interface LogSink extends DispatchLog {
    warn(message: string): void;
}

/** Default log: retains the most recent MAX_LOG_RECORDS error records in memory. */
export class CollectingLog implements EngineLog {
    readonly #records: Array<HandlerErrorRecord & { phase?: string; disabled?: boolean }> = [];
    #sink: LogSink | null = null;

    /** Installs the host's sink beneath the ring, which keeps recording either way. */
    setSink(sink: LogSink | null): void {
        this.#sink = sink;
    }

    error(record: HandlerErrorRecord & { phase?: string; disabled?: boolean }): void {
        // Capped: a session runs for hours and an unbounded array is a slow leak that only shows
        // up on the machine already having a bad day.
        if (this.#records.length >= MAX_LOG_RECORDS) {
            this.#records.shift();
        }
        this.#records.push(record);
        this.#sink?.error(record);
    }

    warn(message: string): void {
        // Not a record: a warning is not a handler throw, and the ring is what `records` promises.
        this.#sink?.warn(message);
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
    readonly #collecting = new CollectingLog();
    readonly log: EngineLog = this.#collecting;
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

    #wired: Wired | null = null;

    /** The local player on a client runtime; undefined on the server. */
    localPlayer?: Player | null;
    /** Persisted @serverState from a previous session, keyed by (hostId, field). */
    persisted?: PersistedSource;
    /**
     * The id the bundle stamped on a class, for the `attach` op that names it on the wire.
     *
     * A function rather than the registry itself: core mints no ids and must not import the package
     * that builds one, which imports core.
     */
    scriptIdOf?: (klass: abstract new (...args: never[]) => object) => ScriptId | undefined;
    worldBounds?: Bounds;
    /** For the host's accumulator to honour; `step` runs a tick regardless. */
    paused = false;

    /** Everything `loadGame` built. */
    get wired(): Wired {
        if (this.#wired === null) throw new LoadError('runtime not loaded — call loadGame() first');
        return this.#wired;
    }

    /** The same set, or null — for the facades whose contract is to no-op outside a loaded world. */
    get wiredOrNull(): Wired | null {
        return this.#wired;
    }

    /** @internal — `loadGame` installs the whole set at once. */
    install(wired: Wired): void {
        this.#wired = wired;
    }

    // Delegating accessors so a consumer outside core reaches the same objects; core reads `wired`.
    get playerManager(): PlayerManager {
        return this.wired.playerManager;
    }
    get wiring(): Wiring {
        return this.wired.wiring;
    }
    get lagRing(): LagRing {
        return this.wired.lagRing;
    }
    get gameInstance(): Game {
        return this.wired.gameInstance;
    }
    get assets(): Assets {
        return this.wired.assets;
    }
    get passes(): TickPasses {
        return this.wired.passes;
    }
    set passes(passes: TickPasses) {
        this.wired.passes = passes;
    }

    constructor() {
        // Registration order is capture and apply order.
        this.registry.register(this.entities);
        this.registry.register(this.transforms);
        this.registry.register(this.tags);
        this.registry.register(this.prng);
        this.registry.register(this.breaker);
        this.registry.register(this.timers);

        // Counters are keyed by instance id and nothing else names one, so a removed host's would
        // sit in the map for the life of the process.
        this.instances.setOnRemoved((instanceId) => this.breaker.forgetInstance(instanceId));

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

    /** Routes this runtime's diagnostics to the host; the default log keeps its ring regardless. */
    setLogSink(sink: LogSink | null): void {
        this.#collecting.setSink(sink);
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
        const id = key === undefined ? undefined : entityIdOfKey(key);
        return id === undefined ? -1 : entityIndex(id);
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

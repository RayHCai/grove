import type { ScriptProps } from '@platform/project';
import { defined } from '@platform/math';
import type { EntityId } from '../ids.js';
import { LoadError } from '../errors.js';
import type { BaseScript, ScriptLocation } from '../script/index.js';
import { getMetadata } from '../script/index.js';
import { makeInstance } from '../dispatch/instances.js';
import type { DispatchOptions } from '../dispatch/dispatcher.js';
import { STATE_BACKING, authoredValue, redirectState } from '../state/backing.js';
import { tagOf, tagsMatch } from '../state/host-record.js';
import type { HostRecord } from '../state/host-record.js';
import { StatefulWrapper } from './wrappers.js';
import { setScriptRuntime } from './script-runtime.js';
import type { Runtime } from './runtime.js';
import type { Player } from './player.js';
import type { Camera } from './camera.js';
import type { HUDScreen } from './hud.js';
import type { Entity } from './entity.js';
import { cameraKey, entityKey, playerKey, screenKey, GAME_KEY } from './hosts.js';
import type { HostKind } from './hosts.js';

/**
 * What core requires of a script class, as against the `AnyScriptClass` one arrives as: an attach
 * instantiates it and writes `host` onto the result. The two meet here, which is the one place an
 * authored class is taken on trust.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- attach accepts any host-typed class
type AttachedScriptClass = new (props?: ScriptProps) => BaseScript<any>;

export class Wiring {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    /** Attaches to an entity and journals it; a class with no bundle id attaches locally only. */
    attachToEntity(id: EntityId, klass: AttachedScriptClass, props?: ScriptProps): object {
        const entity = this.#rt.entityManager.facade(id);
        const instance = this.#attach(
            'entity',
            entityKey(id as number),
            entity,
            klass,
            undefined,
            props,
        );
        const script = this.#rt.scriptIdOf?.(klass);
        if (script !== undefined) {
            this.#rt.channels.markStructural({
                kind: 'attach',
                id,
                script,
                ...defined({ props }),
            });
        }
        return instance;
    }

    attachToPlayer(player: Player, klass: AttachedScriptClass, props?: ScriptProps): object {
        return this.#attach('player', playerKey(player.id), player, klass, player, props);
    }

    attachToGame(game: object, klass: AttachedScriptClass, props?: ScriptProps): object {
        return this.#attach('game', GAME_KEY, game, klass, undefined, props);
    }

    attachToCamera(camera: Camera, klass: AttachedScriptClass, props?: ScriptProps): object {
        const player = camera.player;
        return this.#attach('camera', cameraKey(player.id), camera, klass, player, props);
    }

    attachToScreen(screen: HUDScreen, klass: AttachedScriptClass, props?: ScriptProps): object {
        return this.#attach(
            'screen',
            screenKey(screen.name),
            screen,
            klass,
            this.#rt.localPlayer ?? undefined,
            props,
        );
    }

    attachMovement(avatar: Entity, klass: AttachedScriptClass): object {
        // BaseMovement.tick's stage order is the contract both endpoints replay, so an override
        // desyncs prediction. Counted, not compared: importing that class drags in a decorated
        // module.
        let declarations = 0;
        for (
            let p: object | null = (klass as unknown as { prototype: object }).prototype;
            p && p !== Object.prototype;
            p = Object.getPrototypeOf(p) as object | null
        ) {
            if (Object.hasOwn(p, 'tick')) declarations++;
        }
        if (declarations > 1) {
            throw new LoadError(
                `${klass.name} overrides tick(); override accelerate, applyForces or clampSpeed instead`,
            );
        }
        return this.attachToEntity(avatar.entityId, klass);
    }

    #attach(
        kind: HostKind,
        hostKey: string,
        host: object,
        klass: AttachedScriptClass,
        localPlayer: Player | undefined,
        props?: ScriptProps,
    ): object {
        const location = (klass as unknown as { __location: ScriptLocation }).__location;
        this.#reject(klass, kind, location);

        const entry = this.#rt.hosts.ensure(hostKey);
        // A wrapper on this host marks its key on the state channel through the record.
        entry.record.markDirty ??= (field) => this.#rt.channels.markState(entry.record, field);

        let instance: BaseScript<object>;
        try {
            instance = new klass(props) as BaseScript<object>;
            (instance as { host: object }).host = host;
            setScriptRuntime(instance, this.#rt);
            if (localPlayer && location === 'client') {
                (instance as { localPlayer?: Player }).localPlayer = localPlayer;
            }
            // BETWEEN construction and the hoist, and that ordering is the whole correctness
            // argument: the hoist moves each `@serverState` field's authored value into the host
            // record, so a prop written after it would be overwritten by the initializer it is
            // there to override. Written here it lands in the backing map the hoist then reads.
            applyProps(instance, props);
            this.#hoistState(instance, host, entry.record, kind);
            this.#bindWrappers(instance, entry.record);
        } catch (err) {
            // Fatal, not logged: a half-hoisted host record matches no declaration.
            throw new LoadError(
                `wiring ${klass.name} onto ${hostKey} threw: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const si = makeInstance(instance, klass, entry.scopeId, props);
        this.#rt.instances.attach(hostKey, si);

        return instance;
    }

    // Hoisting onto the host too is what makes `this.credits` and `player.credits` one value.
    #hoistState(instance: object, host: object, record: HostRecord, kind: HostKind): void {
        const backing = (instance as Record<symbol, Map<string, unknown> | undefined>)[
            STATE_BACKING
        ];
        if (!backing) return;
        const mark = (field: string): void => this.#rt.channels.markState(record, field);
        for (const field of backing.keys()) {
            if (record.values.has(field) && !record.wrappers.has(field)) {
                throw new Error(`duplicate @serverState name "${field}" on host`);
            }
            // Nothing but the engine can have put this name on the host. Left alone, a prototype
            // member is REPLACED by the accessor, and `game.players.filter(...)` throws far away.
            if (field in host) {
                throw new LoadError(
                    `@serverState "${field}" is already a member of the ${kind} it is hosted on; rename the field`,
                );
            }
            const authored = authoredValue(instance, field);
            const declaredTag = tagOf(authored);
            // A persisted value whose tag no longer matches the declaration is discarded.
            const persisted = this.#rt.persisted?.get(record.hostId, field);
            const seed =
                persisted !== undefined && tagsMatch(tagOf(persisted), declaredTag)
                    ? persisted
                    : authored;
            record.values.set(field, seed);
            record.tags.set(field, declaredTag);
            this.#hoistOntoHost(host, field, record, mark);
        }
        redirectState(instance, record.values, mark);
    }

    #hoistOntoHost(
        host: object,
        field: string,
        record: HostRecord,
        mark: (field: string) => void,
    ): void {
        // Unconditional: `#hoistState` has already refused every name the host answered to, so a
        // guard here would only hide a collision it was supposed to have caught.
        Object.defineProperty(host, field, {
            configurable: true,
            enumerable: true,
            get() {
                return record.values.get(field);
            },
            set(value: unknown) {
                record.values.set(field, value);
                mark(field);
            },
        });
    }

    // The wrapper goes into `values` alongside every other field: it IS the field's value, and the
    // replication path reads that map — a wrapper left out of it marks a channel whose drain then
    // finds nothing and drops the write.
    #bindWrappers(instance: object, record: HostRecord): void {
        for (const [field, value] of Object.entries(instance)) {
            if (!(value instanceof StatefulWrapper)) continue;
            value.bind(record, field);
            record.wrappers.add(field);
            record.values.set(field, value);
            // Seeded like a decorated field, and for the same reason: the initializer built an
            // empty wrapper, and a previous session's contents are exactly what the host record
            // holds. `restore` already ignores a payload tagged with another class, so a stale one
            // is inert.
            const persisted = this.#rt.persisted?.get(record.hostId, field);
            if (persisted !== undefined) value.restore(persisted);
        }
    }

    #reject(klass: AttachedScriptClass, kind: HostKind, location: ScriptLocation): void {
        if (location === 'synced' && (kind === 'camera' || kind === 'screen')) {
            throw new LoadError(
                `SyncedScript on a ${kind} host has no authoritative copy to reconcile`,
            );
        }
        if (location === 'server' && kind === 'screen') {
            throw new LoadError('ServerScript<HUDScreen> — a screen exists on one machine');
        }
        const meta = getMetadata(klass);
        const hasRequest = meta?.handlers.some((h) => h.kind === 'onRequest') ?? false;
        if (hasRequest && location !== 'server') {
            throw new LoadError('@onRequest is declarable on a ServerScript and nowhere else');
        }
        const hasRoster =
            meta?.handlers.some((h) => h.kind === 'onPlayerJoin' || h.kind === 'onPlayerLeave') ??
            false;
        if (hasRoster && !(kind === 'game' && location === 'server')) {
            throw new LoadError('@onPlayerJoin / @onPlayerLeave are Game-hosted ServerScript only');
        }
    }
}

/**
 * Object keys a prop may not name: assigning one rewrites the instance rather than a field.
 * The same three transport's codec refuses, restated: importing its set would be a value import.
 */
const RESERVED_PROPS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Writes each configured prop onto the instance; authoritative for any field it names. */
function applyProps(instance: object, props: ScriptProps | undefined): void {
    if (props === undefined) return;
    for (const [key, value] of Object.entries(props)) {
        if (RESERVED_PROPS.has(key)) continue;
        (instance as Record<string, unknown>)[key] = value;
    }
}

// One set per role rather than one per call: this is read once a tick and never written.
const SERVER_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['server', 'synced']);
const CLIENT_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['client', 'synced']);

/** Which locations run here: server+synced on a server, client+synced on a client. */
export function activeLocationsFor(role: 'server' | 'client'): ReadonlySet<ScriptLocation> {
    return role === 'server' ? SERVER_LOCATIONS : CLIENT_LOCATIONS;
}

export type { DispatchOptions };

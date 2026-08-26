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
import { entityKey, playerKey, GAME_KEY } from './hosts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- attach accepts any host-typed class
type AnyScriptClass = new () => BaseScript<any>;

export class Wiring {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    attachToEntity(id: EntityId, klass: AnyScriptClass): object {
        const entity = this.#rt.entityManager.facade(id);
        return this.#attach(entityKey(id as number), entity, klass, undefined);
    }

    attachToPlayer(player: Player, klass: AnyScriptClass): object {
        return this.#attach(playerKey(player.id), player, klass, player);
    }

    attachToGame(game: object, klass: AnyScriptClass): object {
        return this.#attach(GAME_KEY, game, klass, undefined);
    }

    attachToCamera(camera: Camera, klass: AnyScriptClass): object {
        return this.#attach(`camera:${camera.player.id}`, camera, klass, camera.player);
    }

    attachToScreen(screen: HUDScreen, klass: AnyScriptClass): object {
        return this.#attach(
            `screen:${screen.name}`,
            screen,
            klass,
            this.#rt.localPlayer ?? undefined,
        );
    }

    attachMovement(avatar: Entity, klass: AnyScriptClass): object {
        // BaseMovement.tick's stage order is the contract both endpoints replay, so an override
        // desyncs prediction. Counted, not compared: importing that class drags in a decorated module.
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

    attachTemplateScripts(_avatar: Entity): void {
        // No template script registry exists, so there is nothing to attach.
    }

    #attach(
        hostKey: string,
        host: object,
        klass: AnyScriptClass,
        localPlayer: Player | undefined,
    ): object {
        const location = (klass as unknown as { __location: ScriptLocation }).__location;
        this.#reject(klass, hostKey, location);

        const entry = this.#rt.hosts.ensure(hostKey);
        // A wrapper on this host marks its key on the state channel through the record.
        entry.record.markDirty ??= (field) => this.#rt.channels.markState(entry.record, field);

        let instance: BaseScript<object>;
        try {
            instance = new klass() as BaseScript<object>;
            (instance as { host: object }).host = host;
            setScriptRuntime(instance, this.#rt);
            if (localPlayer && location === 'client') {
                (instance as { localPlayer?: Player }).localPlayer = localPlayer;
            }
            this.#hoistState(instance, host, entry.record);
            this.#bindWrappers(instance, entry.record);
        } catch (err) {
            // Fatal, not logged: a half-hoisted host record matches no declaration.
            throw new LoadError(
                `wiring ${klass.name} onto ${hostKey} threw: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const si = makeInstance(instance, klass, entry.scopeId);
        this.#rt.instances.attach(hostKey, si);

        return instance;
    }

    // Hoisting onto the host too is what makes `this.credits` and `player.credits` one value.
    #hoistState(instance: object, host: object, record: HostRecord): void {
        const backing = (instance as Record<symbol, Map<string, unknown> | undefined>)[
            STATE_BACKING
        ];
        if (!backing) return;
        const mark = (field: string): void => this.#rt.channels.markState(record, field);
        for (const field of backing.keys()) {
            if (record.values.has(field) && !record.wrappers.has(field)) {
                throw new Error(`duplicate @serverState name "${field}" on host`);
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
        if (Object.prototype.hasOwnProperty.call(host, field)) return;
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
            // Seeded like a decorated field, and for the same reason: the initializer built an empty
            // wrapper, and a previous session's contents are exactly what the host record holds.
            // `restore` already ignores a payload tagged with another class, so a stale one is inert.
            const persisted = this.#rt.persisted?.get(record.hostId, field);
            if (persisted !== undefined) value.restore(persisted);
        }
    }

    #reject(klass: AnyScriptClass, hostKey: string, location: ScriptLocation): void {
        const kind = hostKey.split(':')[0];
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

// One set per role rather than one per call: this is read once a tick and never written.
const SERVER_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['server', 'synced']);
const CLIENT_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['client', 'synced']);

/** Which locations run here: server+synced on a server, client+synced on a client. */
export function activeLocationsFor(role: 'server' | 'client'): ReadonlySet<ScriptLocation> {
    return role === 'server' ? SERVER_LOCATIONS : CLIENT_LOCATIONS;
}

export type { DispatchOptions };

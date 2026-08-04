// Wiring attaches a script to a host (DESIGN §8.1, §8.3): it constructs the instance, sets
// `host`, records it for dispatch, hoists @serverState onto the host record (redirecting
// the accessor pair, §5.2), binds any wrapper fields, and runs @onStart. It also carries
// `send` — the dispatcher call an Entity.send routes through.
//
// Wire exceptions are fatal (§4.4): a script whose @serverState installed some accessors
// then threw leaves a host record matching no declaration, so wiring aborts rather than
// continuing into a second, unrelated failure.

import type { EntityId } from '../ids.js';
import { LoadError } from '../errors.js';
import type { BaseScript, ScriptLocation } from '../script/index.js';
import { getMetadata } from '../script/index.js';
import { makeInstance } from '../dispatch/instances.js';
import type { DispatchOptions } from '../dispatch/dispatcher.js';
import {
    STATE_BACKING,
    authoredValue,
    redirectState,
} from '../state/backing.js';
import { tagOf } from '../state/host-record.js';
import type { HostRecord } from '../state/host-record.js';
import { StatefulWrapper } from './wrappers.js';
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
    /** Which locations run here — server: server+synced; client: client+synced (§1.2). */
    readonly activeLocations: ReadonlySet<ScriptLocation>;

    constructor(rt: Runtime, activeLocations: ReadonlySet<ScriptLocation>) {
        this.#rt = rt;
        this.activeLocations = activeLocations;
    }

    // ─── host-typed attach entry points ─────────────────────────────────────────

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
        return this.#attach(`screen:${screen.name}`, screen, klass, this.#rt.localPlayer ?? undefined);
    }

    /** Attaches a movement class to an avatar and returns the instance (roster path). */
    attachMovement(avatar: Entity, klass: AnyScriptClass): object {
        return this.attachToEntity(avatar.entityId, klass);
    }

    /** Attaches every script the entity's template declares (roster / spawn path). */
    attachTemplateScripts(_avatar: Entity): void {
        // Panel-authored template script lists are supplied via the manifest; with none
        // registered this is a no-op. loadGame populates the template registry.
    }

    // ─── the attach mechanism (§8.1, §8.3, §5.2) ────────────────────────────────

    #attach(hostKey: string, host: object, klass: AnyScriptClass, localPlayer: Player | undefined): object {
        const location = (klass as unknown as { __location: ScriptLocation }).__location;
        this.#reject(klass, hostKey, location);

        const entry = this.#rt.hosts.ensure(hostKey);
        // A wrapper on this host marks its key on the state channel through the record.
        entry.record.markDirty ??= field => this.#rt.channels.markState(entry.record, field);

        let instance: BaseScript<object>;
        try {
            instance = new klass() as BaseScript<object>;
            (instance as { host: object }).host = host;
            if (localPlayer && location === 'client') {
                (instance as { localPlayer?: Player }).localPlayer = localPlayer;
            }
            this.#hoistState(instance, entry.record);
            this.#bindWrappers(instance, entry.record);
        } catch (err) {
            // Wire is fatal — the host record is half-mutated (§4.4).
            throw new LoadError(
                `wiring ${klass.name} onto ${hostKey} threw: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const si = makeInstance(instance, klass, entry.scopeId);
        this.#rt.instances.attach(hostKey, si);

        // @onStart runs during attach when the host already exists (§8.1). The lifecycle
        // dispatch is driven by the loop for load-time attaches; addScript runs it now.
        return instance;
    }

    /** Seeds the host record for each @serverState field and redirects the accessor pair. */
    #hoistState(instance: object, record: HostRecord): void {
        const backing = (instance as Record<symbol, Map<string, unknown> | undefined>)[STATE_BACKING];
        if (!backing) return;
        for (const field of backing.keys()) {
            if (record.values.has(field) && !record.wrappers.has(field)) {
                // Two scripts on one host declaring one name is a load-time error (§3.4).
                throw new Error(`duplicate @serverState name "${field}" on host`);
            }
            const authored = authoredValue(instance, field);
            const declaredTag = tagOf(authored);
            // Seed from a persisted value if its tag matches, else the authored one (§5.2 step 3).
            const persisted = this.#rt.persisted?.get(record.hostId, field);
            const seed =
                persisted !== undefined && tagsMatchLoose(tagOf(persisted), declaredTag)
                    ? persisted
                    : authored;
            record.values.set(field, seed);
            record.tags.set(field, declaredTag);
        }
        redirectState(instance, record.values, field => this.#rt.channels.markState(record, field));
    }

    /** Binds every StatefulWrapper field to the host record (§5.2). */
    #bindWrappers(instance: object, record: HostRecord): void {
        for (const [field, value] of Object.entries(instance)) {
            if (value instanceof StatefulWrapper) {
                value.bind(record, field);
                record.wrappers.add(field);
            }
        }
    }

    /** Wire-time structural rejections (§3.4). */
    #reject(klass: AnyScriptClass, hostKey: string, location: ScriptLocation): void {
        const kind = hostKey.split(':')[0];
        if (location === 'synced' && (kind === 'camera' || kind === 'screen')) {
            throw new LoadError(`SyncedScript on a ${kind} host has no authoritative copy to reconcile (§1.1)`);
        }
        if (location === 'server' && kind === 'screen') {
            throw new LoadError('ServerScript<HUDScreen> — a screen exists on one machine (§1.1)');
        }
        const meta = getMetadata(klass);
        const hasRequest = meta?.handlers.some(h => h.kind === 'onRequest') ?? false;
        if (hasRequest && location !== 'server') {
            throw new LoadError('@onRequest is declarable on a ServerScript and nowhere else (§5.9)');
        }
        const hasRoster = meta?.handlers.some(h => h.kind === 'onPlayerJoin' || h.kind === 'onPlayerLeave') ?? false;
        if (hasRoster && !(kind === 'game' && location === 'server')) {
            throw new LoadError('@onPlayerJoin / @onPlayerLeave are Game-hosted ServerScript only (§5.2)');
        }
    }
}

function tagsMatchLoose(a: ReturnType<typeof tagOf>, b: ReturnType<typeof tagOf>): boolean {
    if (a.kind !== b.kind) return false;
    if ((a.kind === 'object' || a.kind === 'array') && (b.kind === 'object' || b.kind === 'array')) {
        return a.shape === b.shape;
    }
    return true;
}

export function activeLocationsFor(role: 'server' | 'client'): ReadonlySet<ScriptLocation> {
    return role === 'server' ? new Set<ScriptLocation>(['server', 'synced']) : new Set<ScriptLocation>(['client', 'synced']);
}

export type { DispatchOptions };

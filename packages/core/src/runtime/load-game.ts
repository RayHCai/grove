// Every collaborator the facades reach for is constructed here, so runtime.ts stays declarations.

import type { Bounds } from '@platform/math';
import type { EntityId } from '../ids.js';
import type { HandlerKind, ScriptLocation } from '../script/index.js';
import { Broadphase } from '../world/broadphase.js';
import { ContactSource } from './contacts.js';
import { RuntimeGame, WorldQuery } from './game.js';
import { LagRing } from './lag-ring.js';
import { PlayerManager } from './player.js';
import type { Player } from './player.js';
import { RegionIndex } from './regions.js';
import { RuntimeRandom } from './random.js';
import { Roster } from './roster.js';
import { Storage } from './wrappers.js';
import { Camera } from './camera.js';
import { Entity } from './entity.js';
import { Asset, AssetRegistry } from './assets.js';
import type { AssetKind } from './assets.js';
import { Wiring, activeLocationsFor } from './wiring.js';
import { createRuntime } from './runtime.js';
import type { Runtime, TickPasses } from './runtime.js';
import type { DispatchCtx, DispatchOptions } from '../dispatch/dispatcher.js';
import { entityKey } from './hosts.js';
import { liveTransformView } from './transform-view.js';

export interface GameManifest {
    role?: 'server' | 'client';
    simRate?: number;
    bounds?: Bounds;
    regions?: Array<{ name: string; bounds: Bounds }>;
    /** Panel-loaded assets, referenced by key. */
    assets?: Array<{
        key: string;
        kind: AssetKind;
        meta?: { width?: number; height?: number; duration?: number };
    }>;
    /** Panel-authored Game-hosted script classes. */
    gameScripts?: Array<new () => object>;
}

/** Builds and wires a runtime for `manifest`, returning it live. */
export function loadGame(manifest: GameManifest = {}): Runtime {
    const rt = createRuntime();
    const role = manifest.role ?? 'server';
    rt.isServer = role === 'server';
    if (manifest.simRate) rt.setSimRate(manifest.simRate);

    if (manifest.bounds) rt.worldBounds = manifest.bounds;
    rt.regions = new RegionIndex();
    for (const r of manifest.regions ?? []) rt.regions.define(r.name, r.bounds);

    rt.entityManager.makeFacade = (id: EntityId) => new Entity(id, rt);
    rt.playerManager = new PlayerManager(rt);
    rt.random = new RuntimeRandom(rt);
    rt.roster = new Roster(rt);
    rt.contacts = new ContactSource(rt);
    rt.query = new WorldQuery(rt);
    rt.broadphase = new Broadphase(liveTransformView(rt));
    rt.lagRing = new LagRing(rt.transforms, rt.entities, rt.simRate);
    rt.wiring = new Wiring(rt);
    rt.gameInstance = new RuntimeGame(rt);

    const registry = new AssetRegistry();
    for (const a of manifest.assets ?? []) registry.define(new Asset(a.key, a.kind, a.meta));
    rt.assets = registry;

    rt.makeCamera = (player: Player) => new Camera(rt, player);
    rt.makeStorage = (player: Player) => new Storage(rt.kv, `player:${player.id}`);
    rt.send = (id, event, payload) => dispatchTo(rt, id, event, payload);
    rt.requestSink = (name, payload) => deliverRequest(rt, name, payload);
    rt.passes = makePasses(rt);

    // Wire and hoist only; @onStart waits for startGame, so a handler sees a built world.
    for (const klass of manifest.gameScripts ?? []) {
        rt.wiring.attachToGame(rt.gameInstance, klass as never);
    }

    return rt;
}

/** Runs @onStart to its first await; a join can land before a Game @onStart resumes. */
export function startGame(rt: Runtime): Promise<void> {
    return dispatchLifecycle(rt, 'onStart', '@start');
}

/** Creates the player record, then lets @onPlayerJoin decide spawn or spectate. */
export function joinPlayer(rt: Runtime, id: string, name: string): Player {
    const player = rt.playerManager!.create(id, name);
    void dispatchToHost(rt, 'game', 'onPlayerJoin', '@playerJoin', { player });
    return player;
}

/** Ends a session; @onPlayerLeave runs before removal, while the player is still readable. */
export function leavePlayer(rt: Runtime, id: string): void {
    const player = rt.playerManager?.byId(id);
    if (!player) return;
    void dispatchToHost(rt, 'game', 'onPlayerLeave', '@playerLeave', { player });
    rt.playerManager?.remove(id);
}

/** The per-tick half of a DispatchCtx; `extra` carries whatever the event itself supplies. */
function tickCtx(rt: Runtime, extra?: Omit<Partial<DispatchCtx>, 'dt' | 'alive'>): DispatchCtx {
    return { data: {}, dt: 1 / rt.simRate, alive: true, ...extra };
}

function roleLocations(rt: Runtime): ReadonlySet<ScriptLocation> {
    return activeLocationsFor(rt.isServer ? 'server' : 'client');
}

function dispatchLifecycle(rt: Runtime, kind: 'onStart' | 'onEnd', event: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const si of rt.instances.all()) {
        pending.push(
            rt.dispatcher.dispatch([si], kind, event, '', tickCtx(rt), {
                activeLocations: roleLocations(rt),
                tick: rt.tick,
            }),
        );
    }
    return Promise.all(pending).then(() => undefined);
}

function dispatchToHost(
    rt: Runtime,
    hostKey: string,
    kind: 'onPlayerJoin' | 'onPlayerLeave',
    event: string,
    ctx: { player: Player },
): Promise<void> {
    return rt.dispatcher.dispatch(
        rt.instances.forHost(hostKey),
        kind,
        event,
        hostKey,
        tickCtx(rt, { player: ctx.player }),
        { activeLocations: roleLocations(rt), tick: rt.tick },
    );
}

/** Loopback delivery for request(): every server-located @onRequest handler, in place. */
function deliverRequest(
    rt: Runtime,
    name: string,
    payload: Record<string, unknown> | undefined,
): void {
    // ctx.player is engine-supplied and unforgeable; in loopback that is the local player.
    const player = rt.localPlayer ?? rt.playerManager?.players[0] ?? undefined;
    for (const si of rt.instances.all()) {
        if (si.location !== 'server') continue;
        void rt.dispatcher.dispatch(
            [si],
            'onRequest',
            name,
            '',
            tickCtx(rt, { data: payload ?? {}, player, from: null, viewTick: rt.tick }),
            { activeLocations: activeLocationsFor('server'), tick: rt.tick },
        );
    }
}

function dispatchTo(
    rt: Runtime,
    id: EntityId,
    event: string,
    payload: Record<string, unknown> | undefined,
): Promise<void> {
    if (!rt.entities.isAlive(id)) return Promise.resolve();
    const instances = rt.instances.forHost(entityKey(id as number));
    return rt.dispatcher.dispatch(
        instances,
        'onEvent',
        event,
        String(id as number),
        tickCtx(rt, { data: payload ?? {}, from: null }),
        { activeLocations: roleLocations(rt), tick: rt.tick },
    );
}

function makePasses(rt: Runtime): TickPasses {
    const dispatchKind = (dispatch: DispatchOptions, kind: HandlerKind, event: string) => {
        for (const si of rt.instances.all()) {
            void rt.dispatcher.dispatch([si], kind, event, '', tickCtx(rt), dispatch);
        }
    };

    return {
        input() {
            // Core owns no input source; the client and tests dispatch input events themselves.
        },
        movement(dt) {
            for (const player of rt.playerManager?.players ?? []) {
                const movement = player.movement;
                if (!movement) continue;
                // A destroyed avatar leaves its movement instance live, and the physics sink would
                // otherwise keep writing positions for whatever entity reuses the released slot.
                const host = movement.host as unknown as { entityId: EntityId };
                if (!rt.entities.isAlive(host.entityId)) continue;
                movement.tick(dt);
            }
        },
        contacts(dispatch) {
            for (const [a, b] of rt.contacts?.pairs() ?? []) {
                fireCollide(rt, a, b, dispatch);
                fireCollide(rt, b, a, dispatch);
            }
        },
        regions() {
            // Nothing dispatches region enter/exit; find({ in }) queries RegionIndex on demand.
        },
        countdowns() {
            // No Countdown registry exists, so there is nothing to advance.
        },
        update(dispatch, _dt) {
            // A ClientScript's @onUpdate is display-rate via frame(), never the sim step.
            const simUpdate: DispatchOptions = {
                ...dispatch,
                activeLocations: activeLocationsFor('server'),
            };
            dispatchKind(simUpdate, 'onUpdate', '@update');
        },
    };
}

function fireCollide(
    rt: Runtime,
    self: EntityId,
    other: EntityId,
    dispatch: DispatchOptions,
): void {
    const instances = rt.instances.forHost(entityKey(self as number));
    const otherEntity = rt.entityManager.facade(other);
    for (const tag of rt.tags.tagsOf(other)) {
        void rt.dispatcher.dispatch(
            instances,
            'onCollide',
            tag,
            String(self as number),
            tickCtx(rt, { other: otherEntity }),
            dispatch,
        );
    }
}

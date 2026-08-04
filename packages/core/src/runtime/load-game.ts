// loadGame wires a runtime into a live world (DESIGN §8.3). Order is the observable
// contract: build the world, restore @serverState, attach Game scripts (wire + hoist, no
// @onStart yet), start the loop, run Game @onStart to its first await, release joins.
//
// This module instantiates and connects every collaborator the facades reference, so the
// coupling in runtime.ts stays declarations and the wiring lives in one place.

import type { Bounds } from '@platform/math';
import type { EntityId } from '../ids.js';
import type { HandlerKind } from '../script/index.js';
import { Broadphase } from '../world/broadphase.js';
import type { TransformView } from '../world/broadphase.js';
import { ContactSource } from './contacts.js';
import { RuntimeGame, WorldQuery } from './game.js';
import { LagRing } from './lag-ring.js';
import { PlayerManager } from './player.js';
import type { Player } from './player.js';
import { RegionIndex } from './regions.js';
import { RuntimeRandom } from './random.js';
import { Roster } from './roster.js';
import { Storage, setPlayerLookup } from './wrappers.js';
import { Camera } from './camera.js';
import { Entity } from './entity.js';
import { Asset, AssetRegistry, setAssetRegistry } from './assets.js';
import type { AssetKind } from './assets.js';
import { Wiring, activeLocationsFor } from './wiring.js';
import { createRuntime } from './runtime.js';
import type { Runtime, TickPasses } from './runtime.js';
import type { DispatchOptions } from '../dispatch/dispatcher.js';
import { entityKey } from './hosts.js';

export interface GameManifest {
    role?: 'server' | 'client';
    simRate?: number;
    bounds?: Bounds;
    regions?: Array<{ name: string; bounds: Bounds }>;
    /** Panel-loaded assets, referenced by key (§3.5). */
    assets?: Array<{ key: string; kind: AssetKind; meta?: { width?: number; height?: number; duration?: number } }>;
    /** Panel-authored Game-hosted script classes. */
    gameScripts?: Array<new () => object>;
}

/** Builds and wires a runtime for `manifest`, returning it live (§8.3). */
export function loadGame(manifest: GameManifest = {}): Runtime {
    const rt = createRuntime();
    const role = manifest.role ?? 'server';
    rt.isServer = role === 'server';
    if (manifest.simRate) rt.setSimRate(manifest.simRate);

    // 1: build the world — bounds, regions, collaborators.
    if (manifest.bounds) rt.worldBounds = manifest.bounds;
    rt.regions = new RegionIndex();
    for (const r of manifest.regions ?? []) rt.regions.define(r.name, r.bounds);

    rt.entityManager.makeFacade = (id: EntityId) => new Entity(id, rt);
    rt.playerManager = new PlayerManager(rt);
    rt.random = new RuntimeRandom(rt);
    rt.roster = new Roster(rt);
    rt.contacts = new ContactSource(rt);
    rt.query = new WorldQuery(rt);
    rt.broadphase = new Broadphase(transformView(rt));
    rt.lagRing = new LagRing(rt.transforms, rt.simRate);
    rt.wiring = new Wiring(rt, activeLocationsFor(role));
    rt.gameInstance = new RuntimeGame(rt);

    const registry = new AssetRegistry();
    for (const a of manifest.assets ?? []) registry.define(new Asset(a.key, a.kind, a.meta));
    setAssetRegistry(() => registry);

    setPlayerLookup((id: string) => rt.playerManager?.byId(id) ?? null);
    rt.makeCamera = (player: Player) => new Camera(rt, player);
    rt.makeStorage = (player: Player) => new Storage(rt.kv, `player:${player.id}`);
    rt.send = (id, event, payload) => dispatchTo(rt, id, event, payload);
    rt.requestSink = (name, payload) => deliverRequest(rt, name, payload);
    rt.passes = makePasses(rt);

    // 2: restore @serverState from the game record — the wiring seed reads rt.persisted.
    // 3: attach Game scripts — wire + hoist; @onStart runs in startGame (§8.3 step 5).
    for (const klass of manifest.gameScripts ?? []) {
        rt.wiring.attachToGame(rt.gameInstance, klass as never);
    }

    return rt;
}

/**
 * Runs Game-hosted @onStart to its first await, then returns (§8.3 steps 4-5). Joins
 * release afterward — a player's @onStart may run before the Game's has finished, which is
 * why world construction belongs before the first await in a Game @onStart (§3.6).
 */
export function startGame(rt: Runtime): Promise<void> {
    return dispatchLifecycle(rt, 'onStart', '@start');
}

/** Releases a join: player record + avatar + camera + Player scripts, then their @onStart. */
export function joinPlayer(rt: Runtime, id: string, name: string): Player {
    const player = rt.playerManager!.create(id, name);
    // @onPlayerJoin on the Game-hosted ServerScript (§5.2); the handler decides spawn/spectate.
    void dispatchToHost(rt, 'game', 'onPlayerJoin', '@playerJoin', { player });
    return player;
}

/** Fires a lifecycle kind at every attached instance (Game @onStart, etc.). */
function dispatchLifecycle(rt: Runtime, kind: 'onStart' | 'onEnd', event: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const si of rt.instances.all()) {
        pending.push(
            rt.dispatcher.dispatch(
                [si],
                kind,
                event,
                '',
                { data: {}, dt: 1 / rt.simRate, alive: true },
                { activeLocations: activeLocationsFor(rt.isServer ? 'server' : 'client'), tick: rt.tick },
            ),
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
        { data: {}, dt: 1 / rt.simRate, alive: true, player: ctx.player },
        { activeLocations: activeLocationsFor(rt.isServer ? 'server' : 'client'), tick: rt.tick },
    );
}

/** Loopback request delivery: dispatch to @onRequest handlers on Game/Player/Entity hosts. */
function deliverRequest(rt: Runtime, name: string, payload: Record<string, unknown> | undefined): void {
    // ctx.player is engine-supplied and unforgeable (§5.9); the local player in loopback.
    const player = rt.localPlayer ?? rt.playerManager?.players[0] ?? undefined;
    for (const si of rt.instances.all()) {
        if (si.location !== 'server') continue;
        void rt.dispatcher.dispatch(
            [si],
            'onRequest',
            name,
            '',
            { data: payload ?? {}, dt: 1 / rt.simRate, alive: true, player, from: null, viewTick: rt.tick },
            { activeLocations: activeLocationsFor('server'), tick: rt.tick },
        );
    }
}

/** Fires an event at one entity's handlers via the dispatcher (Entity.send, §5.8). */
function dispatchTo(
    rt: Runtime,
    id: EntityId,
    event: string,
    payload: Record<string, unknown> | undefined,
): Promise<void> {
    if (!rt.entities.isAlive(id)) return Promise.resolve(); // dead entity is a no-op (§5.8)
    const instances = rt.instances.forHost(entityKey(id as number));
    return rt.dispatcher.dispatch(
        instances,
        'onEvent',
        event,
        String(id as number),
        { data: payload ?? {}, dt: 1 / rt.simRate, alive: true, from: null },
        { activeLocations: activeLocationsFor(rt.isServer ? 'server' : 'client'), tick: rt.tick },
    );
}

function transformView(rt: Runtime): TransformView {
    return {
        liveIds: (o: EntityId[] = []) => rt.entities.liveIds(o),
        posX: id => rt.transforms.posX(id),
        posY: id => rt.transforms.posY(id),
        halfWidth: () => 0,
        halfHeight: () => 0,
    };
}

/** The per-tick passes (§8.2). Each dispatches a lifecycle/event kind to the right hosts. */
function makePasses(rt: Runtime): TickPasses {
    const dispatchKind = (dispatch: DispatchOptions, kind: HandlerKind, event: string) => {
        for (const si of rt.instances.all()) {
            void rt.dispatcher.dispatch(
                [si],
                kind,
                event,
                '',
                { data: {}, dt: 1 / rt.simRate, alive: true },
                dispatch,
            );
        }
    };

    return {
        input() {
            // Input source drives @onEvent press/release/hold; scripted in tests / by the client.
        },
        movement(dt) {
            for (const player of rt.playerManager?.players ?? []) {
                player.movement?.tick(dt);
            }
        },
        contacts(dispatch) {
            for (const [a, b] of rt.contacts?.pairs() ?? []) {
                fireCollide(rt, a, b, dispatch);
                fireCollide(rt, b, a, dispatch);
            }
        },
        regions() {
            // Region enter/exit + checkpoints — a point query per entity against static shapes.
        },
        countdowns() {
            // Countdowns advance via their own registration; the loop already ticks timers.
        },
        update(dispatch, _dt) {
            dispatchKind(dispatch, 'onUpdate', '@update');
        },
    };
}

function fireCollide(rt: Runtime, self: EntityId, other: EntityId, dispatch: DispatchOptions): void {
    const instances = rt.instances.forHost(entityKey(self as number));
    const otherEntity = rt.entityManager.facade(other);
    for (const tag of rt.tags.tagsOf(other)) {
        void rt.dispatcher.dispatch(
            instances,
            'onCollide',
            tag,
            String(self as number),
            { data: {}, dt: 1 / rt.simRate, alive: true, other: otherEntity },
            dispatch,
        );
    }
}

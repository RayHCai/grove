// Every collaborator the facades reach for is constructed here, so runtime.ts stays declarations.

import type { GameManifest as ProjectGameManifest, ScriptId } from '@platform/project';
import type { EntityId } from '../ids.js';
import type { HandlerKind, ScriptLocation } from '../script/index.js';
import { Broadphase } from '../world/broadphase.js';
import { TemplateRegistry, instantiatePlaced } from '../world/templates.js';
import type { AnyScriptClass, TemplateDef } from '../world/templates.js';
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
import { tickMovement } from './movement-pass.js';
import { Wiring, activeLocationsFor } from './wiring.js';
import { createRuntime } from './runtime.js';
import type { Runtime, TickPasses } from './runtime.js';
import type { DispatchCtx, DispatchOptions } from '../dispatch/dispatcher.js';
import {
    GAME_KEY,
    SCREEN_KEY_PREFIX,
    cameraKey,
    entityKey,
    playerKey,
    screenKey,
} from './hosts.js';
import { HUDState } from './hud.js';
import { liveTransformView } from './transform-view.js';

/**
 * What builds a world.
 *
 * Every field is `@platform/project`'s already-validated narrowing rather than a parallel
 * declaration here, so a field added to the authoring shape cannot reach a runtime without passing
 * through this one type. `validate` is the SERVER's to call — core takes the result and never the
 * file. Optional only so a store-level test can build a bare world; the server hands the whole of it.
 */
export type GameManifest = Partial<Omit<ProjectGameManifest, 'gameScripts'>> & {
    /** Panel-authored Game-hosted script classes. */
    gameScripts?: readonly AnyScriptClass[];
};

/** What a world needs that a manifest cannot hold, because it names code rather than data. */
export interface LoadOptions {
    /**
     * The id the running bundle stamped on a class.
     *
     * Handed in rather than looked up, because the registry that holds it imports core: an
     * `attach` op names an id, so a class this cannot name is attached locally and journaled
     * nowhere.
     */
    scriptIdOf?: (klass: abstract new (...args: never[]) => object) => ScriptId | undefined;
}

/** Builds and wires a runtime for `manifest`, returning it live. */
export function loadGame(manifest: GameManifest = {}, opts: LoadOptions = {}): Runtime {
    const rt = createRuntime();
    const role = manifest.role ?? 'server';
    rt.isServer = role === 'server';
    if (manifest.simRate) rt.setSimRate(manifest.simRate);

    if (manifest.bounds) rt.worldBounds = manifest.bounds;
    rt.regions = new RegionIndex();
    for (const r of manifest.regions ?? []) rt.regions.define(r.name, r.bounds);
    rt.hud = new HUDState();
    if (opts.scriptIdOf !== undefined) rt.scriptIdOf = opts.scriptIdOf;
    rt.templates = TemplateRegistry.from((manifest.templates ?? []) as TemplateDef[]);

    rt.entityManager.makeFacade = (id: EntityId) => new Entity(id, rt);
    rt.entityManager.dispatchEnd = (id: EntityId) => {
        void dispatchToHostKind(rt, entityKey(id as number), 'onEnd', '@end', { alive: false });
    };
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

    // After the Game scripts are hoisted and before any @onStart: the placed world is what a start
    // handler expects to find, and a script hoisted after it would miss its own record's seeding.
    instantiatePlaced(rt, manifest.entities ?? []);

    return rt;
}

/** Runs @onStart to its first await; a join can land before a Game @onStart resumes. */
export function startGame(rt: Runtime): Promise<void> {
    return dispatchLifecycle(rt, 'onStart', '@start');
}

/** The world stopped existing, so every attached script's @onEnd runs — the mirror of startGame. */
export function endGame(rt: Runtime): Promise<void> {
    return dispatchLifecycle(rt, 'onEnd', '@end');
}

/** Creates the player record, then lets @onPlayerJoin decide spawn or spectate. */
export function joinPlayer(rt: Runtime, id: string, name: string): Player {
    const player = rt.playerManager!.create(id, name);
    void dispatchToHostKind(rt, GAME_KEY, 'onPlayerJoin', '@playerJoin', { player });
    return player;
}

/**
 * Ends a session: the player's own hosts wind up, then the Game is told, then the roster drops them.
 *
 * Innermost host outward, and the removal last, so both @onEnd and @onPlayerLeave can still read the
 * player and everything hoisted onto its record.
 */
export function leavePlayer(rt: Runtime, id: string): void {
    const player = rt.playerManager?.byId(id);
    if (!player) return;
    const ended = { player, alive: false };
    void dispatchToHostKind(rt, playerKey(id), 'onEnd', '@end', ended);
    void dispatchToHostKind(rt, cameraKey(id), 'onEnd', '@end', ended);
    void dispatchToHostKind(rt, GAME_KEY, 'onPlayerLeave', '@playerLeave', { player });
    rt.playerManager?.remove(id);
}

/** A HUD widget press, as either endpoint hands one to core. */
export interface WidgetPress {
    widget: string;
    /** The screen the widget belongs to; absent for one outside every screen. */
    screen?: string;
    /** Who pressed it — engine-supplied from the connection, never from the frame. */
    player?: Player;
}

/**
 * Dispatches `@onPress` for one widget.
 *
 * A screen-hosted handler answers only its own screen's widgets, which is what keeps two menus with
 * a `back` button from colliding; every other host resolves the widget across the whole HUD. The
 * rule lives here rather than at either endpoint because both dispatch the same press.
 */
export function pressWidget(rt: Runtime, press: WidgetPress): Promise<void> {
    const onScreen = press.screen === undefined ? undefined : screenKey(press.screen);
    const pending: Promise<void>[] = [];
    for (const [hostKey, si] of rt.instances.entries()) {
        if (hostKey.startsWith(SCREEN_KEY_PREFIX) && hostKey !== onScreen) continue;
        pending.push(
            rt.dispatcher.dispatch(
                [si],
                'onPress',
                press.widget,
                hostKey,
                tickCtx(rt, press.player === undefined ? {} : { player: press.player }),
                { activeLocations: roleLocations(rt), tick: rt.tick },
            ),
        );
    }
    return Promise.all(pending).then(() => undefined);
}

/** Which pointer edge a hit carries. Each is its own handler kind, so the kind IS the edge. */
export type PointerEdge = 'onClick' | 'onHoverEnter' | 'onHoverExit';

const POINTER_EVENT: Readonly<Record<PointerEdge, string>> = {
    onClick: '@click',
    onHoverEnter: '@hoverEnter',
    onHoverExit: '@hoverExit',
};

/**
 * Dispatches a pointer hit at the entity it landed on.
 *
 * The entity is the peer's claim about its own camera and cursor, which no authority can recompute,
 * so this checks only that it is alive — a handler that grants something must check reach itself.
 */
export function pointerHit(
    rt: Runtime,
    edge: PointerEdge,
    id: EntityId,
    player?: Player,
): Promise<void> {
    if (!rt.entities.isAlive(id)) return Promise.resolve();
    return dispatchToHostKind(
        rt,
        entityKey(id as number),
        edge,
        POINTER_EVENT[edge],
        player === undefined ? { other: rt.entityManager.facade(id) } : { player },
    );
}

/** The per-tick half of a DispatchCtx; `extra` carries whatever the event itself supplies. */
function tickCtx(rt: Runtime, extra?: Omit<Partial<DispatchCtx>, 'dt'>): DispatchCtx {
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

/** Fires one kind at one host's scripts, in attachment order. */
function dispatchToHostKind(
    rt: Runtime,
    hostKey: string,
    kind: HandlerKind,
    event: string,
    extra?: Omit<Partial<DispatchCtx>, 'dt'>,
): Promise<void> {
    return rt.dispatcher.dispatch(
        rt.instances.forHost(hostKey),
        kind,
        event,
        hostKey,
        tickCtx(rt, extra),
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

    // Held by the table rather than allocated per tick: the contact walk is O(n²) and the region
    // walk visits every live entity per region, so both run at simRate over the whole world.
    const entered: Array<[EntityId, EntityId]> = [];
    const liveIds: EntityId[] = [];
    const posX = (id: EntityId): number => rt.transforms.posX(id);
    const posY = (id: EntityId): number => rt.transforms.posY(id);

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
                tickMovement(rt, movement, host.entityId, dt);
            }
        },
        contacts(dispatch) {
            for (const [a, b] of rt.contacts?.entered(entered) ?? []) {
                fireCollide(rt, a, b, dispatch);
                fireCollide(rt, b, a, dispatch);
            }
        },
        regions(dispatch) {
            const regions = rt.regions;
            if (!regions) return;
            const ids = rt.entities.liveIds(liveIds);
            for (const crossing of regions.crossings(ids, posX, posY)) {
                // A destroyed entity leaves every region it was in on the tick it dies, and firing
                // @onExit there would run a handler on a host whose @onEnd has not gone out yet.
                if (!crossing.entered && !rt.entities.isAlive(crossing.id)) continue;
                const self = crossing.id as number;
                void rt.dispatcher.dispatch(
                    rt.instances.forHost(entityKey(self)),
                    crossing.entered ? 'onEnter' : 'onExit',
                    crossing.region,
                    String(self),
                    tickCtx(rt),
                    dispatch,
                );
            }
        },
        countdowns(dispatch) {
            // A replayed tick has already spent this countdown: it is wall-facing display timing
            // with no authoritative counterpart, so nothing rewinds it back for the re-run.
            if (dispatch.replay === true) return;
            // Over a copy: an onZero that starts another countdown would otherwise have it advanced
            // on the tick it was created, since a Set visits what an iteration adds.
            for (const countdown of Array.from(rt.countdowns)) {
                // Guarded like a timer's callback: onZero is creator code with no invocation of its
                // own, so an unguarded throw would escape the loop.
                rt.guardCallback(countdown.owner, countdown.guardKey, '@countdown', () =>
                    countdown.advance(),
                );
            }
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

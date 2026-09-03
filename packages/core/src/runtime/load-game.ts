// Every collaborator the facades reach for is constructed here, so runtime.ts stays declarations.

import type { GameManifest as ProjectGameManifest, ScriptId, ScriptProps } from '@platform/project';
import { defined } from '@platform/math';
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
import { createRuntime, withRuntime } from './runtime.js';
import type { LogSink, Runtime, TickPasses } from './runtime.js';
import type { DispatchCtx, DispatchOptions } from '../dispatch/dispatcher.js';
import type { ScriptInstance } from '../dispatch/instances.js';
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
    gameScripts?: readonly GameScriptSpec[];
};

/**
 * A Game-hosted class to attach, or one with the props its inspector configured.
 *
 * The bare class is the props-free form, which is what most Game scripts are and what a test writes.
 */
export type GameScriptSpec = AnyScriptClass | { klass: AnyScriptClass; props?: ScriptProps };

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
    /**
     * Where this world's diagnostics go.
     *
     * Core writes to no console and holds no transport, so without one every `warn` the engine makes
     * ends inside the process that made it.
     */
    log?: LogSink;
    /**
     * What the world's PRNG starts from, defaulting to `DEFAULT_PRNG_SEED`.
     *
     * A world that takes the default replays one stream every session, and a mirror seeded
     * differently from its server draws a different one — so a seed both ends can be told is the
     * only way the two agree.
     */
    seed?: number;
}

/** Builds and wires a runtime for `manifest`, returning it live. */
export function loadGame(manifest: GameManifest = {}, opts: LoadOptions = {}): Runtime {
    const rt = createRuntime();
    // First, so anything the rest of the load warns about already has somewhere to go.
    if (opts.log !== undefined) rt.setLogSink(opts.log);
    // Before the placed world, whose `@onStart`s may already be drawing from it.
    if (opts.seed !== undefined) rt.prng.seed(opts.seed);
    const role = manifest.role ?? 'server';
    rt.isServer = role === 'server';
    if (manifest.simRate) rt.setSimRate(manifest.simRate);

    if (manifest.bounds) rt.worldBounds = manifest.bounds;
    if (opts.scriptIdOf !== undefined) rt.scriptIdOf = opts.scriptIdOf;

    const regions = new RegionIndex();
    for (const r of manifest.regions ?? []) regions.define(r.name, r.bounds);
    const assets = new AssetRegistry();
    for (const a of manifest.assets ?? []) assets.define(new Asset(a.key, a.kind, a.meta));

    rt.entityManager.makeFacade = (id: EntityId) => new Entity(id, rt);
    rt.entityManager.dispatchEnd = (id: EntityId) => {
        void dispatchAt(rt, entityKey(id as number), 'onEnd', '@end', { extra: { alive: false } });
    };

    const wiring = new Wiring(rt);
    const gameInstance = new RuntimeGame(rt);
    rt.install({
        playerManager: new PlayerManager(rt),
        contacts: new ContactSource(rt),
        wiring,
        lagRing: new LagRing(rt.transforms, rt.entities, rt.simRate),
        roster: new Roster(rt),
        send: (id, event, payload) => dispatchTo(rt, id, event, payload),
        makeCamera: (player: Player) => new Camera(rt, player),
        makeStorage: (player: Player) => new Storage(rt.kv, `player:${player.id}`),
        requestSink: (name, payload) => {
            // ctx.player is engine-supplied and unforgeable; in loopback that is the local player.
            const player = rt.localPlayer ?? rt.wired.playerManager.players[0] ?? undefined;
            void deliverRequest(rt, { name, ...defined({ payload, player }) });
        },
        random: new RuntimeRandom(rt),
        assets,
        gameInstance,
        query: new WorldQuery(rt),
        broadphase: new Broadphase(liveTransformView(rt)),
        regions,
        templates: TemplateRegistry.from((manifest.templates ?? []) as TemplateDef[]),
        hud: new HUDState(),
        passes: makePasses(rt),
    });

    // Wire and hoist only; @onStart waits for startGame, so a handler sees a built world.
    for (const spec of manifest.gameScripts ?? []) {
        const { klass, props } =
            typeof spec === 'function' ? { klass: spec, props: undefined } : spec;
        wiring.attachToGame(gameInstance, klass as never, props);
    }

    // After the Game scripts are hoisted and before any @onStart: the placed world is what a start
    // handler expects to find, and a script hoisted after it would miss its own record's seeding.
    instantiatePlaced(rt, manifest.entities ?? []);

    return rt;
}

/**
 * Drains the first batch of deferred `@onStart`s — the Game scripts and the placed world.
 *
 * Not "run every instance's start": attaching queues, and the starts pass drains, so this is the
 * one drain that happens before the loop has stepped at all. It runs to each handler's first await;
 * a join can land before a Game `@onStart` resumes.
 */
export function startGame(rt: Runtime): Promise<void> {
    // Ambient runtime established for the same reason `joinPlayer` establishes it: a second
    // `loadGame` between building this world and starting it repoints the slot every `@onStart`
    // resolves, and the starts pass gets the wrap from the loop rather than from here.
    return withRuntime(rt, () =>
        drainStarts(rt, {
            activeLocations: roleLocations(rt),
            replay: false,
            tick: rt.tick,
        }),
    );
}

/** Dispatches `@onStart` at everything attached since the last drain, in attachment order. */
function drainStarts(rt: Runtime, dispatch: DispatchOptions): Promise<void> {
    const pending = rt.instances.takePendingStarts();
    if (pending.length === 0) return Promise.resolve();
    return Promise.all(
        pending.map(({ hostKey, inst }) =>
            rt.dispatcher.dispatch([inst], 'onStart', '@start', hostKey, tickCtx(rt), dispatch),
        ),
    ).then(() => undefined);
}

/** The world stopped existing, so every attached script's @onEnd runs — the mirror of startGame. */
export function endGame(rt: Runtime): Promise<void> {
    // Ambient runtime established for the same reason `joinPlayer` establishes it; a teardown is as
    // far from a tick as an entry point gets.
    return withRuntime(rt, () => dispatchEach(rt, 'onEnd', '@end'));
}

/** Creates the player record, then lets @onPlayerJoin decide spawn or spectate. */
export function joinPlayer(rt: Runtime, id: string, name: string): Player {
    const player = rt.wired.playerManager.create(id, name);
    // Under `rt`, for the reason `pressWidget` establishes it: a join arrives from a transport
    // callback rather than a tick, so `every`, `after` and `sleep` inside the handler would resolve
    // whichever world `loadGame` ran last — and register a timer in it, silently.
    withRuntime(rt, () => {
        void dispatchAt(rt, GAME_KEY, 'onPlayerJoin', '@playerJoin', { extra: { player } });
    });
    return player;
}

/**
 * Ends a session: the player's own hosts wind up, then the Game is told, then the roster drops them.
 *
 * Innermost host outward, and the removal last, so both @onEnd and @onPlayerLeave can still read the
 * player and everything hoisted onto its record.
 */
export function leavePlayer(rt: Runtime, id: string): void {
    const players = rt.wired.playerManager;
    const player = players.byId(id);
    if (!player) return;
    const ended = { player, alive: false };
    // Ambient runtime established for the same reason `joinPlayer` establishes it; all three are
    // creator handlers reached from a transport callback rather than from a tick.
    withRuntime(rt, () => {
        void dispatchAt(rt, playerKey(id), 'onEnd', '@end', { extra: ended });
        void dispatchAt(rt, cameraKey(id), 'onEnd', '@end', { extra: ended });
        void dispatchAt(rt, GAME_KEY, 'onPlayerLeave', '@playerLeave', { extra: { player } });
    });
    players.remove(id);
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
    // Under `rt`, like a tick is: a handler reached from here writes widgets through `hud`, which
    // resolves the AMBIENT runtime — so without this a press dispatched outside a tick lands in
    // whichever world `loadGame` ran last. One client per page hides it; a process holding a server
    // and two clients does not.
    return withRuntime(rt, () => {
        const onScreen = press.screen === undefined ? undefined : screenKey(press.screen);
        const pending: Promise<void>[] = [];
        // Over a copy: `attach` pushes into the very lists this walks, so a handler that adds a
        // script to its own host would extend this loop for as long as it kept pressing.
        const hosts: string[] = [];
        const instances: ScriptInstance[] = [];
        const found = rt.instances.snapshotByKind('onPress', hosts, instances);
        for (let i = 0; i < found; i++) {
            const hostKey = hosts[i]!;
            if (hostKey.startsWith(SCREEN_KEY_PREFIX) && hostKey !== onScreen) continue;
            pending.push(
                rt.dispatcher.dispatch(
                    [instances[i]!],
                    'onPress',
                    press.widget,
                    hostKey,
                    tickCtx(rt, defined({ player: press.player })),
                    tickDispatch(rt),
                ),
            );
        }
        return Promise.all(pending).then(() => undefined);
    });
}

/**
 * Runs every CLIENT-located `@onUpdate` once, at display rate.
 *
 * `@onUpdate` on a `ClientScript` is specified to fire per frame rather than per tick, and no tick
 * pass can do it: core's update pass and the client's both narrow to server-located handlers, since
 * a synced script's update belongs to the simulation and firing it here as well would double it.
 * So the frame loop calls this, and `location === 'client'` is the whole filter.
 *
 * `dt` is the DISPLAY delta, not `1 / simRate` — a handler easing a bar or a camera is drawing, and
 * the tick length would make it stutter on any monitor that is not the sim rate.
 */
export function displayUpdate(rt: Runtime, dtSeconds: number): void {
    withRuntime(rt, () => {
        // Over a copy: a handler attaching a script mid-pass would otherwise reach it on this same
        // frame, before the starts pass has run its `@onStart`.
        const hosts: string[] = [];
        const instances: ScriptInstance[] = [];
        const found = rt.instances.snapshotByKind('onUpdate', hosts, instances);
        for (let i = 0; i < found; i++) {
            const si = instances[i]!;
            if (si.location !== 'client') continue;
            void rt.dispatcher.dispatch(
                [si],
                'onUpdate',
                '@update',
                hosts[i]!,
                { data: {}, dt: dtSeconds, alive: true },
                { activeLocations: CLIENT_ONLY, tick: rt.tick },
            );
        }
    });
}

/** The one location this pass runs, named once rather than rebuilt per frame. */
const CLIENT_ONLY: ReadonlySet<ScriptLocation> = new Set(['client']);

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
    // Ambient runtime established for the same reason `pressWidget` establishes it.
    return withRuntime(rt, () =>
        dispatchAt(rt, entityKey(id as number), edge, POINTER_EVENT[edge], {
            extra: player === undefined ? { other: rt.entityManager.facade(id) } : { player },
        }),
    );
}

/** The per-tick half of a DispatchCtx; `extra` carries whatever the event itself supplies. */
function tickCtx(rt: Runtime, extra?: Omit<Partial<DispatchCtx>, 'dt'>): DispatchCtx {
    return { data: {}, dt: 1 / rt.simRate, alive: true, ...extra };
}

function roleLocations(rt: Runtime): ReadonlySet<ScriptLocation> {
    return activeLocationsFor(rt.isServer ? 'server' : 'client');
}

/** What a dispatch outside the loop runs under: this role's locations, at the tick last adopted. */
function tickDispatch(rt: Runtime): DispatchOptions {
    return { activeLocations: roleLocations(rt), tick: rt.tick };
}

interface DispatchOverrides {
    extra?: Omit<Partial<DispatchCtx>, 'dt'>;
    /** The loop's own options, which carry `replay`; omitted means this tick's role default. */
    dispatch?: DispatchOptions;
}

/** Fires one kind at one host's scripts, in attachment order. */
function dispatchAt(
    rt: Runtime,
    hostKey: string,
    kind: HandlerKind,
    event: string,
    opts: DispatchOverrides = {},
): Promise<void> {
    return rt.dispatcher.dispatch(
        rt.instances.forHost(hostKey),
        kind,
        event,
        hostKey,
        tickCtx(rt, opts.extra),
        opts.dispatch ?? tickDispatch(rt),
    );
}

/**
 * Fires one kind at every attached script, one dispatch each so each keeps its own ctx.
 *
 * Over `entries` rather than `all` for the host key alone: it is what the error boundary logs as
 * `hostId`, and passing the empty string here left every `@onUpdate`, `@onRequest` and `endGame`
 * throw naming no host — the three paths whose records are hardest to place without one.
 */
function dispatchEach(
    rt: Runtime,
    kind: HandlerKind,
    event: string,
    opts: DispatchOverrides & { only?: ScriptLocation } = {},
): Promise<void> {
    const dispatch = opts.dispatch ?? tickDispatch(rt);
    // Over a copy: a handler attaching a script mid-pass would otherwise take this same dispatch —
    // an `@onUpdate` before its own `@onStart` — and one attaching to its own host would not end.
    // Narrowed by kind first, so an instance that declares no handler of this kind costs nothing
    // past the set probe: the context, the promise and the reaction job below are all per-instance.
    const hosts: string[] = [];
    const instances: ScriptInstance[] = [];
    const found = rt.instances.snapshotByKind(kind, hosts, instances);

    const pending: Promise<void>[] = [];
    for (let i = 0; i < found; i++) {
        const si = instances[i]!;
        if (opts.only !== undefined && si.location !== opts.only) continue;
        pending.push(
            rt.dispatcher.dispatch([si], kind, event, hosts[i]!, tickCtx(rt, opts.extra), dispatch),
        );
    }
    if (pending.length === 0) return Promise.resolve();
    return Promise.all(pending).then(() => undefined);
}

/** One `request()`, as either endpoint hands one to core. */
export interface PlayerRequest {
    name: string;
    /** The only untrusted `ctx.data` in the API: it crossed the wire, and a handler must validate it. */
    payload?: Record<string, unknown>;
    /** Who asked — engine-supplied from the connection, never from the frame. */
    player?: Player;
}

/**
 * Dispatches `@onRequest` at every SERVER-located handler, which is the trust boundary itself.
 *
 * A client mirror holds no server-located instance, so a request that reached this there would
 * dispatch to nothing rather than validate an untrusted ask on the untrusted machine.
 */
export function deliverRequest(rt: Runtime, request: PlayerRequest): Promise<void> {
    // Ambient runtime established for the same reason `pressWidget` establishes it.
    return withRuntime(rt, () =>
        dispatchEach(rt, 'onRequest', request.name, {
            only: 'server',
            extra: {
                data: request.payload ?? {},
                ...defined({ player: request.player }),
                from: null,
                viewTick: rt.tick,
            },
            dispatch: { activeLocations: activeLocationsFor('server'), tick: rt.tick },
        }),
    );
}

function dispatchTo(
    rt: Runtime,
    id: EntityId,
    event: string,
    payload: Record<string, unknown> | undefined,
): Promise<void> {
    if (!rt.entities.isAlive(id)) return Promise.resolve();
    return dispatchAt(rt, entityKey(id as number), 'onEvent', event, {
        extra: { data: payload ?? {}, from: null },
    });
}

function makePasses(rt: Runtime): TickPasses {
    // Held by the table rather than allocated per tick: the contact walk is O(n²) and the region
    // walk visits every live entity per region, so both run at simRate over the whole world.
    const entered: Array<[EntityId, EntityId]> = [];
    const liveIds: EntityId[] = [];
    const posX = (id: EntityId): number => rt.transforms.posX(id);
    const posY = (id: EntityId): number => rt.transforms.posY(id);

    return {
        starts(dispatch) {
            void drainStarts(rt, dispatch);
        },
        input() {
            // Core owns no input source; the client and tests dispatch input events themselves.
        },
        movement(dt) {
            for (const player of rt.wired.playerManager.players) {
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
            for (const [a, b] of rt.wired.contacts.entered(entered)) {
                fireCollide(rt, a, b, dispatch);
                fireCollide(rt, b, a, dispatch);
            }
        },
        regions(dispatch) {
            const ids = rt.entities.liveIds(liveIds);
            for (const crossing of rt.wired.regions.crossings(ids, posX, posY)) {
                // A destroyed entity leaves every region it was in on the tick it dies, and firing
                // @onExit there would run a handler on a host whose @onEnd has not gone out yet.
                if (!crossing.entered && !rt.entities.isAlive(crossing.id)) continue;
                void dispatchAt(
                    rt,
                    entityKey(crossing.id as number),
                    crossing.entered ? 'onEnter' : 'onExit',
                    crossing.region,
                    { dispatch },
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
            void dispatchEach(rt, 'onUpdate', '@update', { dispatch: simUpdate });
        },
    };
}

function fireCollide(
    rt: Runtime,
    self: EntityId,
    other: EntityId,
    dispatch: DispatchOptions,
): void {
    const hostKey = entityKey(self as number);
    const otherEntity = rt.entityManager.facade(other);
    for (const tag of rt.tags.tagsOf(other)) {
        void dispatchAt(rt, hostKey, 'onCollide', tag, { extra: { other: otherEntity }, dispatch });
    }
}

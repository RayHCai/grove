// One server, N tabs, one hand-turned clock — the arrangement a browser host produces, minus the
// socket and the wall clock.
//
// The order inside `step` is the load-bearing part: the authority pumps first and delivers every
// pair itself, then each tab runs its display frame and the host's own after-frame work. A suite
// that sequenced delivery against a step by hand would be reproducing the bug that giving the
// driver `deliver` removes.
//
// Every verb here takes the world it drives as an argument rather than reading one module's, so a
// suite about one API component can stand up a world shaped for that component alone.

import { afterEach, expect } from 'vitest';
import { ClientInstance, ManualFrameSource, ScriptedInputDevice } from '@platform/glue/client';
import type { GameClient } from '@platform/glue/client';
import type { BreakerTrip, EntityId, Runtime } from '@platform/core';
import { GAME_KEY, MemoryKVStore, hud, playerKey, withRuntime } from '@platform/core';
import type { GameInstance } from '@platform/glue/server';
import type { IRenderer, NodeId } from '@platform/renderer';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { GameServer } from '@platform/server';
import type { LoopbackPair } from '@platform/transport';
import { loopbackPair } from '@platform/transport';
import { TEMPLATE_AVATAR } from '../dist/world.js';
import type { World } from '../dist/world.js';
import { createGameInstance } from '../dist/host.js';

const DESIGN = { width: 800, height: 600 };

export interface Tab {
    readonly name: string;
    /** What the host resolved this connection to. Two tabs may share one, as two devices do. */
    readonly identity: string;
    /** What a browser host holds: the composed session, closed as one thing. */
    readonly session: ClientInstance;
    readonly client: GameClient;
    readonly frames: ManualFrameSource;
    readonly device: ScriptedInputDevice;
    readonly renderer: IRenderer;
    /** Present only for a world that asked one widget be drawn. */
    readonly score: ScoreNode | undefined;
    /** Device codes currently held down, so a driver can release what it pressed. */
    readonly held: Set<string>;
    /** The runtime this tab's screens were registered against; a resync mints a different one. */
    opened: Runtime | undefined;
    gone: boolean;
}

/**
 * One numeric widget, drawn on the renderer's `ui` surface.
 *
 * Screen space, so it neither scrolls with the camera nor culls — and text is legal only there. It
 * reads the same replicated field a screen script does, because a node is not a widget and no
 * `hud` verb can reach one.
 */
export class ScoreNode {
    readonly #renderer: IRenderer;
    readonly #widget: string;
    #node: NodeId | undefined;
    #shown = '';

    constructor(renderer: IRenderer, widget: string) {
        this.#renderer = renderer;
        this.#widget = widget;
    }

    /** Called once per frame, behind the client's own. */
    sync(client: GameClient): void {
        const label = String(client.hud.widgetOf(this.#widget)?.number ?? 0);
        if (label === this.#shown && this.#node !== undefined) return;
        this.#shown = label;
        if (this.#node === undefined) {
            this.#node = this.#renderer.createNode({
                kind: 'text',
                surface: 'ui',
                uiAnchor: 'top-center',
                position: { x: 0, y: 24, z: 0 },
                text: label,
                style: { size: 24, color: 0xf2f7f3, weight: 'bold', align: 'center' },
            });
            return;
        }
        if (this.#renderer.isAlive(this.#node)) this.#renderer.setNodeText(this.#node, label);
    }

    /** What the renderer currently draws, so a test can read the art rather than the state. */
    get drawn(): string {
        return this.#shown;
    }

    /** Destroys the one node this owns. The client's own bridge destroys only what it created. */
    dispose(): void {
        const node = this.#node;
        if (node === undefined) return;
        this.#node = undefined;
        if (this.#renderer.isAlive(node)) this.#renderer.destroyNode(node);
    }
}

/** Every session this file handed out, so a failed test still closes what it opened. */
const opened: Session[] = [];

afterEach(() => {
    for (const session of opened.splice(0)) session.dispose();
});

/** A session that closes itself when the test ends, however it ends. */
export function newSession(world: World, store?: MemoryKVStore): Session {
    const session = new Session(world, store);
    opened.push(session);
    return session;
}

export class Session {
    readonly world: World;
    readonly instance: GameInstance;
    readonly store: MemoryKVStore;
    #disposed = false;
    /** Every handler the breaker gave up on. Empty is the only healthy reading. */
    readonly trips: BreakerTrip[] = [];

    readonly #pairs: LoopbackPair[] = [];
    readonly #tabs: Tab[] = [];
    readonly #tick: number;
    #now = 0;

    constructor(world: World, store = new MemoryKVStore()) {
        this.world = world;
        this.store = store;
        this.#tick = 1 / world.simRate;
        this.instance = createGameInstance(world, {
            kv: store,
            now: () => this.#now,
            // The driver calls this first, every pump, so no test ever orders delivery itself.
            deliver: () => {
                for (const pair of this.#pairs) pair.deliver();
            },
            onBreakerTrip: (trip) => this.trips.push(trip),
        });
    }

    /** The authority, for the assertions that read the world the server actually holds. */
    get server(): GameServer {
        return this.instance.server;
    }

    get now(): number {
        return this.#now;
    }

    /** Tabs still connected, in join order. */
    get tabs(): Tab[] {
        return this.#tabs.filter((tab) => !tab.gone);
    }

    /**
     * One more tab, admitted under the identity the HOST resolved.
     *
     * Identified, as a socket host's join is: the server reads that player's persisted record
     * before it allocates a `Player`, and that read is a promise — which is why every step yields
     * to the microtask queue rather than assuming the join completed inside the pump.
     */
    async join(name: string, identity = name): Promise<Tab> {
        const pair = loopbackPair();
        this.#pairs.push(pair);
        expect(this.instance.accept(pair.server, identity)).not.toBeNull();

        const renderer = await createReadyNullRenderer({ design: DESIGN });
        const frames = new ManualFrameSource();
        const device = new ScriptedInputDevice();
        // The composition a browser uses, from the same manifest the server booted from: the
        // identity check is derived once and compared, rather than restated on both ends. Built
        // rather than dialled, which is why the socket layer is a function beside the session
        // instead of inside it — this suite reaches the authority over a loopback pair.
        const session = new ClientInstance({
            transport: pair.client,
            renderer,
            frames,
            device,
            clock: { nowSeconds: () => this.#now },
            name,
            bindings: [...this.world.bindings],
            predict: true,
            scripts: this.world.client,
            project: this.world.project,
            // This harness built the null renderer per tab, and nothing else holds it.
            ownsRenderer: true,
        });
        session.start();

        const widget = this.world.mirrorWidget;
        const tab: Tab = {
            name,
            identity,
            session,
            client: session.client,
            frames,
            device,
            renderer,
            score: widget === undefined ? undefined : new ScoreNode(renderer, widget),
            held: new Set<string>(),
            opened: undefined,
            gone: false,
        };
        this.#tabs.push(tab);
        return tab;
    }

    /** Server first, then every live tab — the order a socket would produce anyway. */
    async step(ticks: number): Promise<void> {
        for (let i = 0; i < ticks; i++) {
            this.#now += this.#tick;
            this.instance.pump();
            for (const tab of this.#tabs) {
                if (tab.gone) continue;
                tab.frames.frame(this.#now);
                // The host's own after-frame work, exactly as a browser app runs it.
                tab.score?.sync(tab.client);
                // Once per RUNTIME rather than once per tab: re-registering every frame would
                // discard the instance the overlay's own switch believes is still up, but a resync
                // throws the mirror away and builds a fresh one whose screen list is empty — so a
                // one-shot flag would lose every screen exactly when a backgrounded tab came back.
                const rt = tab.client.mirror?.runtime;
                if (tab.client.state === 'live' && rt !== undefined && tab.opened !== rt) {
                    tab.opened = rt;
                    openScreens(tab.client, this.world);
                }
            }
            await flushMicrotasks();
        }
    }

    /** Steps until `done` holds, and fails loudly rather than looping forever. */
    async stepUntil(done: () => boolean, limit = 600): Promise<void> {
        for (let i = 0; i < limit; i++) {
            await this.step(1);
            if (done()) return;
        }
        throw new Error(`condition still false after ${limit} ticks`);
    }

    async live(...tabs: Tab[]): Promise<void> {
        await this.stepUntil(() => tabs.every((tab) => tab.client.state === 'live'));
    }

    /** The tab closes. Its transport goes with it, and the authority notices on the next deliver. */
    leave(tab: Tab): void {
        if (tab.gone) return;
        tab.gone = true;
        tab.held.clear();
        tab.score?.dispose();
        tab.session.close();
    }

    hold(tab: Tab, code: string): void {
        if (tab.gone || tab.held.has(code)) return;
        tab.held.add(code);
        tab.device.emit({ kind: 'key', code, down: true });
    }

    release(tab: Tab, code: string): void {
        if (tab.gone || !tab.held.has(code)) return;
        tab.held.delete(code);
        tab.device.emit({ kind: 'key', code, down: false });
    }

    releaseAll(): void {
        // A copy, because releasing takes the code back out of the set being walked.
        for (const tab of this.tabs) {
            const held = Array.from(tab.held);
            for (const code of held) this.release(tab, code);
        }
    }

    /** One press and release of the same code, which is what a tap is. */
    tap(tab: Tab, code: string): void {
        this.hold(tab, code);
        this.release(tab, code);
    }

    /** A widget press, raised from a DOM handler rather than from a frame — so the runtime is named here. */
    press(tab: Tab, widget: string, screen?: string): void {
        if (tab.gone) return;
        const rt = tab.client.mirror?.runtime;
        if (rt === undefined) return;
        withRuntime(rt, () => tab.client.pressWidget(widget, screen));
    }

    /**
     * A click, resolved the way a canvas does it: world point to screen point, screen point to
     * whatever is DRAWN there, and only then to the entity behind it.
     *
     * Answers what it hit, so a caller can tell a click that landed from one that found empty space.
     */
    click(tab: Tab, worldPoint: { x: number; y: number }): EntityId | undefined {
        if (tab.gone) return undefined;
        const at = tab.renderer.worldToScreen(worldPoint);
        const hit = tab.client.entityAt({ x: at.x, y: at.y });
        if (hit === undefined) return undefined;
        // The edges a canvas produces around one press, in the order it produces them.
        tab.client.pointer('onHoverEnter', hit);
        tab.client.pointer('onClick', hit);
        tab.client.pointer('onHoverExit', hit);
        return hit;
    }

    /** A hover that arrives and stays, so a test can read what an entity does while pointed at. */
    hover(tab: Tab, worldPoint: { x: number; y: number }): EntityId | undefined {
        if (tab.gone) return undefined;
        const at = tab.renderer.worldToScreen(worldPoint);
        const hit = tab.client.entityAt({ x: at.x, y: at.y });
        if (hit === undefined) return undefined;
        tab.client.pointer('onHoverEnter', hit);
        return hit;
    }

    unhover(tab: Tab, id: EntityId): void {
        if (tab.gone) return;
        tab.client.pointer('onHoverExit', id);
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const tab of this.#tabs) {
            if (tab.gone) continue;
            tab.gone = true;
            tab.score?.dispose();
            tab.session.close();
        }
        this.instance.close();
    }
}

/**
 * Registers this tab's screens and opens them.
 *
 * A screen is minted on first mention and `hud.screen` answers null until then, so the open below
 * is what brings it into being. In a hosted platform the panel does this from the project file;
 * here the session start is the panel.
 */
export function openScreens(client: GameClient, world: World): void {
    const rt = client.mirror?.runtime;
    if (rt === undefined) return;
    withRuntime(rt, () => {
        for (const spec of world.screens) {
            // A screen is minted on first mention, and `hud.open` attaches whatever it ALREADY
            // carries before marking it visible — then early-returns on every later open. So the
            // class has to be registered while the screen is closed: mint it, close it to discard
            // the empty instance set the first open made, register, and open it for real.
            const screen = hud.open(spec.name);
            // Registered once per runtime; a resync builds a fresh one where the list is empty again.
            if (screen.scripts.length > 0) continue;
            hud.close(spec.name);
            screen.addScript(spec.script as never);
            hud.open(spec.name);
        }
    });
}

/**
 * Turns the microtask queue six times, enough for the admission's promise chain.
 *
 * Not a macrotask flush: nothing on a timer or in I/O runs here.
 */
export async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

export function runtimeOf(tab: Tab): Runtime {
    const mirror = tab.client.mirror;
    if (mirror === undefined) throw new Error(`${tab.name} has no mirror yet`);
    return mirror.runtime;
}

/** One replicated field, read off a host record — where the hoist puts it. */
export function gameField<T>(rt: Runtime, name: string): T | undefined {
    return rt.hosts.get(GAME_KEY)?.record.values.get(name) as T | undefined;
}

export function playerField<T>(rt: Runtime, playerId: string, name: string): T | undefined {
    return rt.hosts.get(playerKey(playerId))?.record.values.get(name) as T | undefined;
}

/** This tab's own replicated field, whoever it turned out to be. */
export function mineField<T>(tab: Tab, name: string): T | undefined {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) return undefined;
    return playerField<T>(runtimeOf(tab), id, name);
}

/** Every live entity carrying `tag`, in whichever world is asked. */
export function taggedIn(rt: Runtime, tag: string): EntityId[] {
    return [...rt.entities.liveIds()].filter((id) => rt.tags.has(id, tag));
}

/** Every live entity minted from `template`. */
export function ofTemplate(rt: Runtime, template: string): EntityId[] {
    return [...rt.entities.liveIds()].filter((id) => rt.entities.record(id)?.template === template);
}

/** The avatar the given player owns, in whichever world is asked — a mirror's or the authority's. */
export function avatarIn(rt: Runtime, playerId: string): EntityId | undefined {
    return [...rt.entities.liveIds()].find((id) => {
        const record = rt.entities.record(id);
        return record?.ownerId === playerId && record.template === TEMPLATE_AVATAR;
    });
}

/** This tab's own avatar, in its own mirror. */
export function avatarOf(tab: Tab): EntityId | undefined {
    const mine = tab.client.localPlayer?.id;
    if (mine === undefined) return undefined;
    return avatarIn(runtimeOf(tab), mine);
}

/** Every template name a world currently holds an entity of. */
export function templatesIn(rt: Runtime): string[] {
    const out: string[] = [];
    for (const id of rt.entities.liveIds()) {
        const template = rt.entities.record(id)?.template;
        if (template !== undefined) out.push(template);
    }
    return out;
}

/** Every drawn field of one entity, read off the transform store rather than through a facade. */
export function transformIn(
    rt: Runtime,
    id: EntityId,
): { x: number; y: number; rotation: number; scale: number; opacity: number; layer: number } {
    return {
        x: rt.transforms.posX(id),
        y: rt.transforms.posY(id),
        rotation: rt.transforms.rotation(id),
        scale: rt.transforms.scale(id),
        opacity: rt.transforms.opacity(id),
        layer: rt.transforms.layer(id),
    };
}

/** The parent an entity is linked under, or undefined at the world root. */
export function parentIn(rt: Runtime, id: EntityId): EntityId | undefined {
    const parent = rt.entities.record(id)?.parent;
    return parent === undefined || parent === 0 ? undefined : parent;
}

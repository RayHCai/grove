// The real clients against the real authority, in one process, over loopback pairs.
//
// Both packages are otherwise validated against a scripted peer — `@platform/client` against a fake
// server, `@platform/server` against a fake client — so this is the first place the two halves meet.
// It is the same project `main.ts` hosts, booted through the same composition roots; only the
// transport and the clock differ, which is what makes it worth running before a socket is involved.
//
// The game's classes come from `dist/`, because they carry decorators and only `tsc` lowers them.

import { describe, it, expect, afterEach } from 'vitest';
import type { GameClient } from '@platform/client';
import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { EntityId, Runtime } from '@platform/core';
import { GAME_KEY, MemoryKVStore, entityKey, playerKey } from '@platform/core';
import { createClient } from '@platform/engine/host';
import { createReadyNullRenderer } from '@platform/renderer/null';
import type { IRenderer } from '@platform/renderer';
import type { GameInstance } from '@platform/glue';
import type { GameServer } from '@platform/server';
import { loopbackPair } from '@platform/transport';
import type { LoopbackPair } from '@platform/transport';
import { createGameInstance } from '../dist/server/host.js';
import { resetSession } from '../dist/scripts/session.js';
import { ClockNode, openHud, pressWidget } from '../src/hud';
import { PROJECT } from '../src/project';
import { CLIENT_SCRIPTS } from '../src/client-registry';
import {
    AVATAR_STEP,
    AVATAR_TEMPLATE,
    BINDINGS,
    CODE_AIM_Y,
    CODE_DOWN,
    CODE_RIGHT,
    CODE_SPAWN,
    CODE_UP,
    CROWN_TEMPLATE,
    DESIGN,
    LEAF_SPEED,
    LEAF_TAG,
    LEAF_TEMPLATE,
    PLAYER_TINTS,
    SCREEN_LOBBY,
    STATE_LIFETIME,
    STATE_PHASE,
    STATE_PLAYER_COUNT,
    STATE_READY,
    STATE_READY_COUNT,
    STATE_RIPE,
    STATE_SECONDS_LEFT,
    STATE_SLOT,
    STATE_WASTED,
    WIDGET_READY,
    WIDGET_SCORE,
    WORLD,
    encodeAim,
    markerTemplate,
} from '../src/scripts/globals';
import { dropBand } from '../dist/scripts/templates/leaf/leaf.js';

const TICK = 1 / 60;

interface Tab {
    client: GameClient;
    frames: ManualFrameSource;
    device: ScriptedInputDevice;
    renderer: IRenderer;
    clock: ClockNode;
    /** Whether the host has registered this tab's screens yet — a once-per-session job. */
    opened: boolean;
}

/**
 * One server, N clients, one hand-turned clock.
 *
 * Every join is IDENTIFIED, as `main.ts`'s is: the server reads that player's persisted record
 * before it allocates a `Player`, and that read is a promise — so every step yields to the
 * microtask queue rather than assuming the join completed inside the pump.
 */
class Session {
    readonly instance: GameInstance;
    readonly store = new MemoryKVStore();
    readonly #pairs: LoopbackPair[] = [];
    readonly #tabs: Tab[] = [];
    #now = 0;

    constructor(store?: MemoryKVStore) {
        if (store !== undefined) (this as { store: MemoryKVStore }).store = store;
        // The same call `main.ts` makes, minus the socket in front of it.
        this.instance = createGameInstance({
            kv: this.store,
            // The clock this suite turns by hand, in place of the wall clock a socket host uses.
            now: () => this.#now,
            // The driver calls this first, every pump, so no test ever orders delivery itself.
            deliver: () => {
                for (const pair of this.#pairs) pair.deliver();
            },
        });
    }

    /** The authority, for the assertions that read the world the server actually holds. */
    get server(): GameServer {
        return this.instance.server;
    }

    async join(name: string, identity = name): Promise<Tab> {
        const pair = loopbackPair();
        this.#pairs.push(pair);
        expect(this.instance.accept(pair.server, identity)).not.toBeNull();

        const renderer = await createReadyNullRenderer({ design: DESIGN });

        const frames = new ManualFrameSource();
        const device = new ScriptedInputDevice();
        // The composition root the browser uses, from the same manifest the server booted from:
        // the identity check is derived once and compared, rather than restated on both ends.
        const client = createClient({
            transport: pair.client,
            renderer,
            frames,
            device,
            clock: { nowSeconds: () => this.#now },
            name,
            bindings: BINDINGS,
            predict: true,
            scripts: CLIENT_SCRIPTS,
            project: PROJECT,
        });
        client.start();

        const tab: Tab = {
            client,
            frames,
            device,
            renderer,
            clock: new ClockNode(renderer),
            opened: false,
        };
        this.#tabs.push(tab);
        return tab;
    }

    /** Server first, then every client — the order a socket would produce anyway. */
    async step(ticks: number): Promise<void> {
        for (let i = 0; i < ticks; i++) {
            this.#now += TICK;
            this.instance.pump();
            for (const tab of this.#tabs) {
                tab.frames.frame(this.#now);
                // The host's own after-frame work, exactly as `use-game.ts` runs it.
                tab.clock.sync(tab.client);
                // Once, on the transition to `live` — which is exactly where `use-game.ts` calls
                // it. Every frame would re-open and re-close each screen, discarding the instances
                // the overlay's own switch believes are still up.
                if (tab.client.state === 'live' && !tab.opened) {
                    tab.opened = true;
                    openHud(tab.client);
                }
            }
            // An identified join awaits a store read before it allocates a Player, so the admission
            // finishes on the microtask queue rather than inside the pump that received it.
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

    click(tab: Tab, worldY: number): void {
        // The same three edges the browser's device wrapper produces: the aim rides the press's own
        // frame, because that sample is the only position the server is ever told.
        tab.device.emit({ kind: 'axis', code: CODE_AIM_Y, value: encodeAim(worldY) });
        tab.device.emit({ kind: 'pointer', button: 0, down: true, screenX: 0, screenY: 0 });
        tab.device.emit({ kind: 'pointer', button: 0, down: false, screenX: 0, screenY: 0 });
    }

    /** Holds a key for `ticks` and releases it. */
    async hold(tab: Tab, code: string, ticks: number): Promise<void> {
        tab.device.emit({ kind: 'key', code, down: true });
        await this.step(ticks);
        tab.device.emit({ kind: 'key', code, down: false });
        await this.step(1);
    }

    /** Readies every tab and steps until the authority says the round is running. */
    async startRound(...tabs: Tab[]): Promise<void> {
        for (const tab of tabs) pressWidget(tab.client, WIDGET_READY, SCREEN_LOBBY);
        await this.stepUntil(() => phaseOf(tabs[0]!) === 'playing', 120);
    }

    dispose(): void {
        for (const tab of this.#tabs) {
            tab.clock.dispose();
            tab.client.destroy({ ownsRenderer: true });
        }
        this.instance.close();
        // The Game captured at start is module state; a second server in this process must not
        // inherit the first's.
        resetSession();
    }
}

/**
 * Turns the microtask queue six times, enough for the admission's promise chain.
 *
 * Not a macrotask flush: nothing on a timer or in I/O runs here.
 */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

function runtimeOf(tab: Tab): Runtime {
    const mirror = tab.client.mirror;
    if (mirror === undefined) throw new Error('no mirror yet');
    return mirror.runtime;
}

/** One replicated field, read off the mirror's host record — where the hoist puts it. */
function gameField<T>(tab: Tab, name: string): T | undefined {
    return runtimeOf(tab).hosts.get(GAME_KEY)?.record.values.get(name) as T | undefined;
}

function playerField<T>(tab: Tab, name: string): T | undefined {
    const id = tab.client.localPlayer?.id;
    if (id === undefined) return undefined;
    return runtimeOf(tab).hosts.get(playerKey(id))?.record.values.get(name) as T | undefined;
}

/** The palette seat the rules assigned this tab — never `player.index`, which is never reused. */
function slotOf(tab: Tab): number {
    return playerField<number>(tab, STATE_SLOT) ?? 0;
}

function phaseOf(tab: Tab): string {
    return gameField<string>(tab, STATE_PHASE) ?? '';
}

function templatesIn(tab: Tab): string[] {
    const rt = runtimeOf(tab);
    const out: string[] = [];
    for (const id of rt.entities.liveIds()) {
        const template = rt.entities.record(id)?.template;
        if (template !== undefined) out.push(template);
    }
    return out;
}

/** Leaves only, by the tag the rules put on them — the zone pips are entities too. */
function leafIds(tab: Tab): EntityId[] {
    const rt = runtimeOf(tab);
    return [...rt.entities.liveIds()].filter((id) => rt.tags.has(id, LEAF_TAG));
}

function leavesIn(tab: Tab): number {
    return leafIds(tab).length;
}

/** Badges only: an avatar and its shadow share the marker sprite and are neither. */
function badgesIn(tab: Tab): string[] {
    const badge = new Set(PLAYER_TINTS.map((_, slot) => markerTemplate(slot)));
    return templatesIn(tab).filter((template) => badge.has(template));
}

/** This tab's own avatar — an entity it owns whose template is the Player one. */
function avatarOf(tab: Tab): EntityId {
    const rt = runtimeOf(tab);
    const mine = tab.client.localPlayer!.id;
    const found = [...rt.entities.liveIds()].find((id) => {
        const record = rt.entities.record(id);
        return record?.ownerId === mine && record.template === AVATAR_TEMPLATE;
    });
    if (found === undefined) throw new Error('no avatar for this tab');
    return found;
}

function scoreWidget(tab: Tab): number {
    return tab.client.hud.widgetOf(WIDGET_SCORE)?.number ?? 0;
}

let session: Session | null = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('the project both ends boot from', () => {
    it('declares a badge template for every slot a player index can land in', () => {
        const declared = new Set(PROJECT.templates.map((template) => template.id as string));
        for (let index = 0; index < PLAYER_TINTS.length * 3; index++) {
            // A template with no manifest entry silently draws a placeholder rather than failing.
            expect(declared.has(markerTemplate(index))).toBe(true);
        }
        expect(declared.has(LEAF_TEMPLATE)).toBe(true);
        expect(declared.has(AVATAR_TEMPLATE)).toBe(true);
    });

    it('names the codes the device actually emits', () => {
        const codes = BINDINGS.map((binding) => binding.code);
        expect(codes).toContain(CODE_SPAWN);
        expect(codes).toContain(CODE_AIM_Y);
        expect(codes).toContain(CODE_UP);
    });
});

describe('a session over the real wire', () => {
    it('joins, welcomes and goes live', async () => {
        session = new Session();
        const tab = await session.join('one');
        expect(tab.client.state).toBe('connecting');

        await session.live(tab);

        expect(tab.client.localPlayer).not.toBeNull();
        // The welcome seeds the clock off the snapshot's tick, so this is the server's world.
        expect(tab.client.stats().depictedTick).toBeGreaterThan(0);
        // Not `droppedAttach`: the client chunk carries no server class by construction, so every
        // server-located attachment the wire names lands there. `unknownNetId` is the one that
        // would mean a real mirror fault at this point.
        expect(tab.client.mirror?.counters.unknownNetId).toBe(0);
    });

    it('delivers the placed world, parents before children', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        const rt = runtimeOf(tab);
        // Eight pips authored in the file: two pivots with three sprites beneath each.
        const zones = [...rt.entities.liveIds()].filter((id) =>
            (rt.entities.record(id)?.template ?? '').startsWith('zone-'),
        );
        expect(zones).toHaveLength(8);
        const parented = zones.filter((id) => rt.entities.record(id)?.parent !== undefined);
        expect(parented.length).toBeGreaterThan(0);
        // A child applied before its parent is the flat-world bug arriving through ordering.
        expect(rt.entities.liveIds().length).toBeGreaterThan(0);
        expect(tab.client.mirror?.counters.outOfOrderParent).toBe(0);
    });

    it('carries the template attachment’s props to the browser on the attach op', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        const rt = runtimeOf(tab);
        const attached = rt.instances.forHost(entityKey(avatarOf(tab) as number));
        const runner = attached.find((instance) => instance.props !== undefined);
        expect(runner).toBeDefined();
        // Configured in `project.ts`, not read from a constant on this side: an inspector value
        // reaches the browser because the wire carries it, and the field it landed on proves it.
        expect(runner!.props).toEqual({ step: AVATAR_STEP });
        expect((runner!.instance as { step?: number }).step).toBe(AVATAR_STEP);
    });

    it('mints the avatar’s shadow from the template’s own subtree', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        const rt = runtimeOf(tab);
        const avatar = avatarOf(tab);
        const children = rt.entities.record(avatar)?.children ?? [];
        // One spawn key, two entities: nothing in the game parents a shadow by hand.
        expect(children).toHaveLength(1);
        expect(rt.entities.record(children[0]!)?.template).toBe('player-shadow');
        // The subtree inherits its root's owner, which is what makes it die with the tab.
        expect(rt.entities.record(children[0]!)?.ownerId).toBe(tab.client.localPlayer!.id);
    });

    it('runs this tab’s own avatar ahead of the server, and lands on the same answer', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        const rt = runtimeOf(tab);
        const avatar = avatarOf(tab);
        const start = rt.transforms.posX(avatar);

        tab.device.emit({ kind: 'key', code: CODE_RIGHT, down: true });
        await session.step(30);

        // Ahead of the tick it is being shown, by the ticks it has replayed over it.
        const moving = tab.client.stats();
        expect(rt.transforms.posX(avatar)).toBeGreaterThan(start);
        expect(moving.localTick).toBeGreaterThan(moving.depictedTick);
        expect(moving.resimulations).toBeGreaterThan(0);

        tab.device.emit({ kind: 'key', code: CODE_RIGHT, down: false });
        await session.step(30);

        // The authority ran the same script on the same input, so the two agree exactly — and the
        // client never had to be snapped back to get there.
        const server = session.server.runtime;
        const authoritative = [...server.entities.liveIds()].find((id) => {
            const record = server.entities.record(id);
            return (
                record?.ownerId === tab.client.localPlayer!.id &&
                record.template === AVATAR_TEMPLATE
            );
        })!;
        expect(rt.transforms.posX(avatar)).toBeCloseTo(server.transforms.posX(authoritative), 6);
        expect(tab.client.prediction?.counters.snappedCorrections).toBe(0);
    });

    it('resolves a click on the avatar to the avatar, through the drawn scene', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        // A frame past the welcome, so the bridge has created the node and pushed a pose into it.
        await session.step(4);

        const avatar = avatarOf(tab);
        const rt = runtimeOf(tab);
        // The avatar is PREDICTED, so what is drawn is what is simulated — the one entity whose
        // screen position a test can compute without knowing the interpolation delay.
        const at = tab.renderer.worldToScreen({
            x: rt.transforms.posX(avatar),
            y: rt.transforms.posY(avatar),
        });

        expect(tab.client.entityAt({ x: at.x, y: at.y })).toBe(avatar);
        // Far off the body, and nothing else is drawn there.
        expect(tab.client.entityAt({ x: at.x + 400, y: at.y })).toBeUndefined();
    });

    it('predicts on both axes, and clamps the avatar onto the stage', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        const rt = runtimeOf(tab);
        const avatar = avatarOf(tab);
        const start = rt.transforms.posY(avatar);

        await session.hold(tab, CODE_UP, 20);
        expect(rt.transforms.posY(avatar)).toBeGreaterThan(start);

        // Far more ticks than the stage is tall: the clamp is part of what both ends replay.
        await session.hold(tab, CODE_DOWN, 200);
        expect(rt.transforms.posY(avatar)).toBeGreaterThanOrEqual(WORLD.bottom);
        expect(tab.client.prediction?.counters.snappedCorrections).toBe(0);
    });

    it('predicts only what this tab owns: another tab’s avatar waits for the server', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);

        const runtimeA = runtimeOf(a);
        const bInA = [...runtimeA.entities.liveIds()].find((id) => {
            const record = runtimeA.entities.record(id);
            return (
                record?.ownerId === b.client.localPlayer!.id && record.template === AVATAR_TEMPLATE
            );
        })!;
        const before = runtimeA.transforms.posX(bInA);

        // `b` holds the key; `a` sees b's avatar move only as envelopes land, never replayed.
        await session.hold(b, CODE_RIGHT, 20);
        await session.step(20);

        expect(runtimeA.transforms.posX(bInA)).toBeGreaterThan(before);
        expect([...a.client.prediction!.scope]).not.toContain(bInA);
    });
});

describe('the lobby', () => {
    it('plants a leaf where the click said, badged in the planter’s colour', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        expect(leavesIn(tab)).toBe(0);

        session.click(tab, 120);
        await session.stepUntil(() => leavesIn(tab) > 0);
        await session.step(4);

        expect(leavesIn(tab)).toBe(1);
        const leaf = leafIds(tab)[0]!;
        const rt = runtimeOf(tab);
        expect(rt.transforms.posY(leaf)).toBeCloseTo(120, 6);
        expect(badgesIn(tab)).toEqual([markerTemplate(slotOf(tab))]);
    });

    it('shows one tab the leaf another tab planted', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);

        session.click(a, -80);
        await session.stepUntil(() => leavesIn(b) > 0);
        await session.step(4);

        expect(leavesIn(a)).toBe(1);
        expect(runtimeOf(b).transforms.posY(leafIds(b)[0]!)).toBeCloseTo(-80, 6);
        // The badge says who planted it, and every tab reads the same template.
        expect(badgesIn(b)).toEqual([markerTemplate(slotOf(a))]);
    });

    it('clears every planted leaf for everyone when one tab asks', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);

        session.click(a, 100);
        session.click(b, -100);
        await session.stepUntil(() => leavesIn(a) >= 1 && leavesIn(b) >= 1);
        await session.step(8);

        b.device.emit({ kind: 'key', code: 'keys:KeyC', down: true });
        b.device.emit({ kind: 'key', code: 'keys:KeyC', down: false });
        await session.stepUntil(() => leavesIn(a) === 0);

        expect(leavesIn(b)).toBe(0);
    });

    it('keeps a leaf alive after the tab that planted it disconnects', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);

        session.click(a, 0);
        await session.stepUntil(() => leavesIn(b) > 0);
        await session.step(4);
        expect(leavesIn(b)).toBe(1);

        // Leaves are spawned unowned precisely so this does not destroy them: the server sweeps
        // every entity whose ownerId matches a departing player.
        a.client.destroy({ ownsRenderer: true });
        await session.step(30);

        expect(leavesIn(b)).toBe(1);
    });
});

describe('a round', () => {
    it('starts only when every seated player has readied', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);
        expect(phaseOf(a)).toBe('lobby');

        // The interaction frame, not an input action — the one creator-facing command channel.
        pressWidget(a.client, WIDGET_READY, SCREEN_LOBBY);
        await session.step(10);
        expect(gameField<number>(a, STATE_READY_COUNT)).toBe(1);
        expect(phaseOf(a)).toBe('lobby');

        b.client.pressWidget(WIDGET_READY, SCREEN_LOBBY);
        await session.stepUntil(() => phaseOf(a) === 'playing', 120);
        // Both tabs are told, because the phase is Game-hosted rather than per player.
        expect(phaseOf(b)).toBe('playing');
    });

    it('drops its own leaves, badged for a seated player, and runs a clock', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);

        await session.stepUntil(() => leavesIn(tab) >= 2, 240);
        const rt = runtimeOf(tab);
        const band = dropBand(rt.worldBounds!);
        for (const leaf of leafIds(tab)) {
            const y = rt.transforms.posY(leaf);
            expect(y).toBeGreaterThanOrEqual(band.low - 1);
            expect(y).toBeLessThanOrEqual(band.high + 1);
        }
        // One tab seated, so every badge is that tab's slot — `random.pick` draws from the roster.
        const slot = slotOf(tab);
        expect(new Set(badgesIn(tab))).toEqual(new Set([markerTemplate(slot)]));

        await session.stepUntil(() => (gameField<number>(tab, STATE_SECONDS_LEFT) ?? 99) < 45, 200);
        expect(gameField<number>(tab, STATE_SECONDS_LEFT)).toBeLessThan(45);
    });

    it('ripens a leaf inside the bonus band and lets it wither on the way out', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);

        // Every leaf crosses the middle of the stage, so one of them is ripe within a few seconds.
        await session.stepUntil(() => leafIds(tab).some((id) => ripe(tab, id)), 600);
        const ripened = leafIds(tab).find((id) => ripe(tab, id))!;
        const rt = runtimeOf(tab);
        // The region wrote a scale as well as a flag, so the change is visible without a second sprite.
        expect(rt.transforms.scale(ripened)).toBeGreaterThan(3);

        await session.stepUntil(() => !rt.entities.isAlive(ripened) || !ripe(tab, ripened), 600);
        if (rt.entities.isAlive(ripened)) expect(rt.transforms.scale(ripened)).toBeCloseTo(3, 6);
    });

    it('composts a leaf nobody caught, and counts it', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);

        // 1024 world px of travel plus the wire, with slack for the join.
        const crossing = Math.ceil(((960 + 64) / LEAF_SPEED) * 60) + 120;
        await session.stepUntil(() => (gameField<number>(tab, STATE_WASTED) ?? 0) > 0, crossing);
        expect(gameField<number>(tab, STATE_WASTED)).toBeGreaterThan(0);
    });

    it('scores a leaf walked into, and tells the harvester’s HUD', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);

        const rt = runtimeOf(tab);
        // Cross to the far side first, so the next leaf has the whole stage to reach us in.
        await session.hold(tab, CODE_RIGHT, 200);

        // Re-aim each pass rather than steering once at the first leaf seen: leaf heights are
        // `game.random`'s, so a single manoeuvre only lands when the stream happens to drop one
        // within reach — which makes the test a property of the seed rather than of the harvest.
        for (let attempt = 0; attempt < 12 && scoreWidget(tab) === 0; attempt++) {
            await session.stepUntil(() => leavesIn(tab) > 0, 200);
            const target = leafIds(tab).reduce((lowest, id) =>
                rt.transforms.posX(id) < rt.transforms.posX(lowest) ? id : lowest,
            );
            const dy = rt.transforms.posY(target) - rt.transforms.posY(avatarOf(tab));
            if (Math.abs(dy) >= 1) {
                await session.hold(tab, dy > 0 ? CODE_UP : CODE_DOWN, Math.ceil(Math.abs(dy) / 4));
            }
            await session.step(30);
        }

        expect(scoreWidget(tab)).toBeGreaterThan(0);
        // A harvest is worth more than the click that steals it.
        expect(scoreWidget(tab)).toBeGreaterThanOrEqual(2);
    });

    it('pops a leaf a tab clicked, wherever it is', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);
        await session.stepUntil(() => leavesIn(tab) > 0, 120);

        const rt = runtimeOf(tab);
        const target = leafIds(tab)[0]!;
        tab.client.pointer('onClick', target);
        await session.stepUntil(() => !rt.entities.isAlive(target), 120);
        expect(scoreWidget(tab)).toBeGreaterThan(0);
    });
});

describe('the results screen and the lobby after it', () => {
    it('carries the round on when one of two players leaves, minus their seat', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);
        await session.startRound(a, b);
        expect(phaseOf(a)).toBe('playing');

        b.client.destroy({ ownsRenderer: true });
        // The roster still holds the leaver when `@onPlayerLeave` runs — the removal is last — so
        // the recount is told who to leave out rather than counting them one last time.
        await session.stepUntil(() => gameField<number>(a, STATE_PLAYER_COUNT) === 1, 200);
        expect(phaseOf(a)).toBe('playing');
    });

    it('starts the round when the tab holding it up is the one that leaves', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);

        pressWidget(a.client, WIDGET_READY, SCREEN_LOBBY);
        await session.stepUntil(() => gameField<number>(a, STATE_READY_COUNT) === 1, 120);
        expect(phaseOf(a)).toBe('lobby');

        // Without the recount's own start check this leaves the lobby reading "1/1 ready" with
        // nothing running until somebody pressed ready twice.
        b.client.destroy({ ownsRenderer: true });
        await session.stepUntil(() => phaseOf(a) === 'playing', 200);
    });

    it('clears the stage, spectates everyone, and crowns the winner with art declared just now', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);

        // Score once, so the round has a winner to crown.
        await session.stepUntil(() => leavesIn(tab) > 0, 120);
        tab.client.pointer('onClick', leafIds(tab)[0]!);
        await session.stepUntil(() => scoreWidget(tab) > 0, 120);

        const second = await session.join('two');
        await session.live(second);
        second.client.destroy({ ownsRenderer: true });

        // The clock runs the round out. 45 seconds at 60 Hz, plus the wire.
        await session.stepUntil(() => phaseOf(tab) === 'results', 3200);

        expect(leavesIn(tab)).toBe(0);
        // `spectate` destroyed the avatar, which is why every loop over players guards on hasAvatar.
        expect(() => avatarOf(tab)).toThrow();
        expect(templatesIn(tab)).toContain(CROWN_TEMPLATE);
        // The crown's art was declared mid-session, so the client can actually draw it.
        expect(tab.client.stats().assetLoadFailed).toBe(0);
    });

    it('reopens the lobby and respawns everyone', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);
        await session.stepUntil(() => phaseOf(tab) === 'results', 3200);

        // The results dwell, counted down by the same one-second tick that publishes the round.
        await session.stepUntil(() => phaseOf(tab) === 'lobby', 900);
        expect(templatesIn(tab)).not.toContain(CROWN_TEMPLATE);
        expect(() => avatarOf(tab)).not.toThrow();
        expect(gameField<number>(tab, STATE_READY_COUNT)).toBe(0);
    });

    it('leaves a tab that joined during the results with one avatar, not two', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);
        await session.stepUntil(() => phaseOf(tab) === 'results', 3200);

        // This one is spawned by the join handler while everyone else is spectating, so the reopen
        // finds it already holding an avatar — `spawn` would mint a second and orphan the first.
        const late = await session.join('late');
        await session.live(late);
        await session.stepUntil(() => phaseOf(tab) === 'lobby', 900);
        await session.step(8);

        const rt = runtimeOf(tab);
        const mine = late.client.localPlayer!.id;
        const avatars = [...rt.entities.liveIds()].filter((id) => {
            const record = rt.entities.record(id);
            return record?.ownerId === mine && record.template === AVATAR_TEMPLATE;
        });
        expect(avatars).toHaveLength(1);
    });
});

describe('the HUD', () => {
    it('reaches the sink as widgets and screens, not as React state', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.step(2);

        const named = new Set(tab.client.hud.widgets.map((widget) => widget.name));
        expect(named.has(WIDGET_READY)).toBe(true);
        expect(named.has(WIDGET_SCORE)).toBe(true);
        // The bridge opens the lobby screen for the phase the authority is in.
        expect(tab.client.hud.openScreens).toContain(SCREEN_LOBBY);
    });

    it('lets the authority’s label win over the screen script’s placeholder', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.step(4);

        // `hud.open` dispatches `LobbyScreen.@onStart` inside the call, and that writes a static
        // 'ready up'. The bridge opens the screen BEFORE its own widget writes for this reason —
        // opened after, the placeholder would stand until the authority's answer next changed.
        expect(tab.client.hud.widgetOf(WIDGET_READY)?.text).toContain('0/1');
    });

    it('answers a press locally, and lets the authority correct it', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        await session.live(a, b);
        await session.step(2);

        // `LobbyScreen.@onPress` runs on this call — a screen's `@onStart` and its presses are the
        // only client-located handlers anything dispatches.
        pressWidget(a.client, WIDGET_READY, SCREEN_LOBBY);
        expect(a.client.hud.widgetOf(WIDGET_READY)?.enabled).toBe(false);

        // The authority's answer arrives as replicated state, and the bridge rewrites the label.
        await session.stepUntil(() => (gameField<number>(a, STATE_READY_COUNT) ?? 0) === 1, 120);
        await session.step(2);
        expect(a.client.hud.widgetOf(WIDGET_READY)?.text).toContain('1/2');
    });

    it('draws the round clock on the renderer’s ui surface', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);
        await session.startRound(tab);
        await session.step(4);

        const scene = tab.renderer.inspect({ surface: 'ui' });
        const roots = scene.roots.ui ?? [];
        expect(roots.length).toBeGreaterThan(0);
        const clock = scene.nodes.get(roots[0]!)!;
        expect(clock.kind).toBe('text');
        expect(clock.uiAnchor).toBe('top-center');
        expect(Number(clock.text)).toBeGreaterThan(0);
    });
});

describe('what outlives a session', () => {
    it('reads a rejoining player’s totals back under the same identity', async () => {
        const store = new MemoryKVStore();
        session = new Session(store);
        const tab = await session.join('one', 'stable-id');
        await session.live(tab);
        await session.startRound(tab);

        await session.stepUntil(() => leavesIn(tab) > 0, 120);
        tab.client.pointer('onClick', leafIds(tab)[0]!);
        await session.stepUntil(() => scoreWidget(tab) > 0, 120);

        // The round has to END for a total to be banked, and the socket has to close for it to be
        // written through — that leave is the only session boundary this server owns.
        await session.stepUntil(() => phaseOf(tab) === 'results', 3200);
        await session.step(4);
        const banked = playerField<number>(tab, STATE_LIFETIME) ?? 0;
        expect(banked).toBeGreaterThan(0);

        session.dispose();
        await flushMicrotasks();

        session = new Session(store);
        const back = await session.join('one', 'stable-id');
        await session.live(back);
        await session.step(4);

        expect(playerField<number>(back, STATE_LIFETIME)).toBe(banked);
    });

    it('gives a fresh identity nothing', async () => {
        const store = new MemoryKVStore();
        session = new Session(store);
        const tab = await session.join('one', 'someone-else');
        await session.live(tab);
        await session.step(4);

        expect(playerField<number>(tab, STATE_LIFETIME)).toBe(0);
    });

    it('does not carry a ready flag across a rejoin', async () => {
        const store = new MemoryKVStore();
        session = new Session(store);
        const tab = await session.join('one', 'stable-id');
        const other = await session.join('two', 'other-id');
        await session.live(tab, other);

        pressWidget(tab.client, WIDGET_READY, SCREEN_LOBBY);
        await session.stepUntil(() => (gameField<number>(tab, STATE_READY_COUNT) ?? 0) === 1, 120);
        session.dispose();
        await flushMicrotasks();

        // `ready` rides the same host record `lifetimeLeaves` does, so it is written through on the
        // leave — a rejoin that trusted the save would come back already readied, and the first
        // press would UN-ready them rather than start anything.
        session = new Session(store);
        const back = await session.join('one', 'stable-id');
        await session.live(back);
        await session.step(4);

        expect(playerField<boolean>(back, STATE_READY)).toBe(false);
        expect(gameField<number>(back, STATE_READY_COUNT)).toBe(0);
    });

    it('reuses a palette seat a departed player left, rather than counting up forever', async () => {
        session = new Session();
        const first = await session.join('first', 'a');
        await session.live(first);
        expect(slotOf(first)).toBe(0);

        // Core allocates `player.index` from a counter a leave never lowers, so keying the palette
        // off it would give the ninth tab of a session the hue and the spawn point of the first.
        for (let n = 0; n < 3; n++) {
            const churn = await session.join(`churn-${n}`, `churn-${n}`);
            await session.live(churn);
            expect(slotOf(churn)).toBe(1);
            churn.client.destroy({ ownsRenderer: true });
            await session.step(4);
        }

        const last = await session.join('last', 'z');
        await session.live(last);
        expect(last.client.localPlayer!.index).toBeGreaterThan(1);
        expect(slotOf(last)).toBe(1);
        expect(slotOf(last)).not.toBe(slotOf(first));
    });
});

describe('the wire itself', () => {
    it('drops no input frame the server would refuse', async () => {
        session = new Session();
        const tab = await session.join('one');
        await session.live(tab);

        session.click(tab, 200);
        await session.step(30);

        // A refused or lost frame stalls the ack and leaves the ring occupied.
        expect(tab.client.stats().ringSize).toBe(0);
        expect(tab.client.stats().state).toBe('live');
        // Nonzero means replication silently dropped something as unrepresentable.
        expect(session.server.droppedMarks).toBe(0);
        expect(tab.client.mirror?.counters.oversizedList).toBe(0);
        expect(tab.client.mirror?.counters.invalidNetId).toBe(0);
    });
});

/** Whether the leaf's own replicated flag says it is inside the bonus band. */
function ripe(tab: Tab, id: EntityId): boolean {
    const rt = runtimeOf(tab);
    if (!rt.entities.isAlive(id)) return false;
    return rt.hosts.get(entityKey(id as number))?.record.values.get(STATE_RIPE) === true;
}

// The real client against the real server, in one process, over a loopback pair.
//
// Both packages are otherwise validated against a scripted peer — `@platform/client` against a fake
// server, `@platform/server` against a fake client — so this is the first place the two halves meet.
// It is the same game `main.ts` hosts; only the transport and the clock differ, which is what makes
// it worth running before a socket is involved.
//
// `Rules` and `Clicker` come from `dist/`, because they carry decorators and only `tsc` lowers them.

import { describe, it, expect, afterEach } from 'vitest';
import { GameClient, ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { Binding } from '@platform/client';
import { createNullRenderer } from '@platform/renderer/null';
import type { IRenderer } from '@platform/renderer';
import { GameServer } from '@platform/server';
import { loopbackPair } from '@platform/transport';
import type { LoopbackPair } from '@platform/transport';
import type { EntityId } from '@platform/core';
import { serverConfig } from '../dist/server/config.js';
import { Runner } from '../dist/synced/runner.js';
import {
    AVATAR_TEMPLATE,
    BINDINGS,
    CODE_AIM_Y,
    CODE_RIGHT,
    CODE_SPAWN,
    DESIGN,
    LEAF_TEMPLATE,
    PLAYER_TINTS,
    PROJECT_HASH,
    PROJECT_ID,
    encodeAim,
    markerTemplate,
} from '../src/shared';
import { EDGE_MARGIN, LEAF_SPEED, spawnX } from '../src/server/leaf';

const TICK = 1 / 60;

interface Tab {
    client: GameClient;
    frames: ManualFrameSource;
    device: ScriptedInputDevice;
    renderer: IRenderer;
}

/** One server, N clients, one hand-turned clock. */
class Session {
    readonly server: GameServer;
    readonly #pairs: LoopbackPair[] = [];
    readonly #tabs: Tab[] = [];
    #now = 0;

    constructor() {
        this.server = new GameServer({
            config: serverConfig(),
            // The driver calls this first, every pump, so no test ever orders delivery itself.
            deliver: () => {
                for (const pair of this.#pairs) pair.deliver();
            },
        });
    }

    async join(name: string): Promise<Tab> {
        const pair = loopbackPair();
        this.#pairs.push(pair);
        expect(this.server.accept(pair.server)).not.toBeNull();

        const renderer = createNullRenderer();
        // The null backend measures no container and never touches this.
        await renderer.init({ container: null as unknown as HTMLElement, design: DESIGN });

        const frames = new ManualFrameSource();
        const device = new ScriptedInputDevice();
        const client = new GameClient({
            transport: pair.client,
            renderer,
            frames,
            device,
            clock: { nowSeconds: () => this.#now },
            name,
            bindings: BINDINGS as readonly Binding[],
            // The same pair `use-game.ts` passes: this suite is only worth running on what ships.
            predict: true,
            scripts: { [AVATAR_TEMPLATE]: [Runner] },
            // As `use-game.ts` declares it. The server config declares the same, so the handshake's
            // identity check passes here and this suite covers the agreeing path end to end.
            project: { projectId: PROJECT_ID, projectHash: PROJECT_HASH, bundleHash: '' },
        });
        client.start();

        const tab: Tab = { client, frames, device, renderer };
        this.#tabs.push(tab);
        return tab;
    }

    /** Server first, then every client — the order a socket would produce anyway. */
    step(ticks: number): void {
        for (let i = 0; i < ticks; i++) {
            this.#now += TICK;
            this.server.pump(this.#now);
            for (const tab of this.#tabs) tab.frames.frame(this.#now);
        }
    }

    /** Steps until `done` holds, and fails loudly rather than looping forever. */
    stepUntil(done: () => boolean, limit = 600): void {
        for (let i = 0; i < limit; i++) {
            this.step(1);
            if (done()) return;
        }
        throw new Error(`condition still false after ${limit} ticks`);
    }

    click(tab: Tab, worldY: number): void {
        // The same three edges the browser's device wrapper produces: the aim rides the press's own
        // frame, because that sample is the only position the server is ever told.
        tab.device.emit({ kind: 'axis', code: CODE_AIM_Y, value: encodeAim(worldY) });
        tab.device.emit({ kind: 'pointer', button: 0, down: true, screenX: 0, screenY: 0 });
        tab.device.emit({ kind: 'pointer', button: 0, down: false, screenX: 0, screenY: 0 });
    }

    dispose(): void {
        for (const tab of this.#tabs) tab.client.destroy({ ownsRenderer: true });
        this.server.close();
    }
}

function templatesIn(tab: Tab): string[] {
    const runtime = tab.client.mirror?.runtime;
    if (runtime === undefined) return [];
    const out: string[] = [];
    for (const id of runtime.entities.liveIds()) {
        const template = runtime.entities.record(id)?.template;
        if (template !== undefined) out.push(template);
    }
    return out;
}

/** Leaves only — each one carries a separate badge entity, which this deliberately does not count. */
function leavesIn(tab: Tab): number {
    return templatesIn(tab).filter((t) => t === LEAF_TEMPLATE).length;
}

/** Badges only: one avatar per connected tab shares the same sprite and is not one. */
function badgesIn(tab: Tab): string[] {
    return templatesIn(tab).filter((t) => t !== LEAF_TEMPLATE && t !== AVATAR_TEMPLATE);
}

/** This tab's own avatar — the one entity it owns, and so the only one it predicts. */
function avatarOf(tab: Tab): EntityId {
    const runtime = tab.client.mirror!.runtime;
    const mine = tab.client.localPlayer!.id;
    const found = [...runtime.entities.liveIds()].find(
        (id) => runtime.entities.record(id)?.ownerId === mine,
    );
    if (found === undefined) throw new Error('no avatar for this tab');
    return found;
}

let session: Session | null = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('a session over the real wire', () => {
    it('joins, welcomes and goes live', async () => {
        session = new Session();
        const tab = await session.join('one');
        expect(tab.client.state).toBe('connecting');

        session.stepUntil(() => tab.client.state === 'live');

        expect(tab.client.state).toBe('live');
        expect(tab.client.localPlayer).not.toBeNull();
        // The welcome seeds the clock off the snapshot's tick, so this is the server's world.
        expect(tab.client.stats().depictedTick).toBeGreaterThan(0);
    });

    it('runs this tab’s own avatar ahead of the server, and lands on the same answer', async () => {
        session = new Session();
        const tab = await session.join('one');
        session.stepUntil(() => tab.client.state === 'live');

        const runtime = tab.client.mirror!.runtime;
        const avatar = avatarOf(tab);
        const start = runtime.transforms.posX(avatar);

        tab.device.emit({ kind: 'key', code: CODE_RIGHT, down: true });
        session.step(30);

        // Ahead of the tick it is being shown, by the ticks it has replayed over it.
        const moving = tab.client.stats();
        expect(runtime.transforms.posX(avatar)).toBeGreaterThan(start);
        expect(moving.localTick).toBeGreaterThan(moving.depictedTick);
        expect(moving.resimulations).toBeGreaterThan(0);

        tab.device.emit({ kind: 'key', code: CODE_RIGHT, down: false });
        session.step(30);

        // The authority ran the same script on the same input, so the two agree exactly — and the
        // client never had to be snapped back to get there.
        const server = session.server.runtime;
        const authoritative = [...server.entities.liveIds()].find(
            (id) => server.entities.record(id)?.ownerId === tab.client.localPlayer!.id,
        )!;
        expect(runtime.transforms.posX(avatar)).toBeCloseTo(
            server.transforms.posX(authoritative),
            6,
        );
        expect(tab.client.prediction?.counters.snappedCorrections).toBe(0);
    });

    it('predicts only what this tab owns: another tab’s avatar waits for the server', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        const scope = a.client.prediction!.scope;
        expect([...scope]).toEqual([avatarOf(a)]);

        const runtimeA = a.client.mirror!.runtime;
        const bInA = [...runtimeA.entities.liveIds()].find(
            (id) => runtimeA.entities.record(id)?.ownerId === b.client.localPlayer!.id,
        )!;
        const before = runtimeA.transforms.posX(bInA);

        // `b` holds the key; `a` sees b's avatar move only as envelopes land, never replayed.
        b.device.emit({ kind: 'key', code: CODE_RIGHT, down: true });
        session.step(20);
        b.device.emit({ kind: 'key', code: CODE_RIGHT, down: false });
        session.step(20);

        expect(runtimeA.transforms.posX(bInA)).toBeGreaterThan(before);
        expect([...a.client.prediction!.scope]).not.toContain(bInA);
        expect([...b.client.prediction!.scope]).toEqual([avatarOf(b)]);
    });

    it('spawns a leaf and its badge where the click said, and nowhere else', async () => {
        session = new Session();
        const tab = await session.join('one');
        session.stepUntil(() => tab.client.state === 'live');
        expect(leavesIn(tab)).toBe(0);

        session.click(tab, 120);
        session.stepUntil(() => leavesIn(tab) > 0);

        // Two entities per click: the leaf, and the badge parented above it.
        session.step(4);
        expect(leavesIn(tab)).toBe(1);

        const runtime = tab.client.mirror!.runtime;
        const ids = [...runtime.entities.liveIds()];
        const roots = ids.filter((id) => runtime.entities.record(id)?.parent === undefined);
        // The leaf, its badge, and this tab's own avatar.
        expect(ids).toHaveLength(3);

        // The leaf is the one with a child; it enters off the left edge at the clicked height.
        const leaf = ids.find((id) => (runtime.entities.record(id)?.children.length ?? 0) > 0)!;
        expect(leaf).toBeDefined();
        expect(roots.length).toBeLessThanOrEqual(3);
        expect(runtime.transforms.posY(leaf)).toBeCloseTo(120, 6);
        expect(runtime.transforms.posX(leaf)).toBeGreaterThanOrEqual(
            spawnX(serverConfig().bounds!),
        );
        expect(runtime.transforms.posX(leaf)).toBeLessThan(0);
    });

    it('badges every leaf with the colour of the tab that spawned it', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        const slotA = a.client.localPlayer!.index;
        const slotB = b.client.localPlayer!.index;
        expect(slotA).not.toBe(slotB);

        session.click(a, 100);
        session.stepUntil(() => leavesIn(b) === 1);
        session.step(4);
        // The tab that did not click sees the same badge, which is the whole point of it.
        expect(badgesIn(b)).toEqual([markerTemplate(slotA)]);

        session.click(b, -100);
        session.stepUntil(() => leavesIn(a) === 2);
        session.step(4);
        expect(badgesIn(a).toSorted()).toEqual(
            [markerTemplate(slotA), markerTemplate(slotB)].toSorted(),
        );
    });

    it('shows one tab the leaf another tab spawned', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        session.click(a, -80);
        session.stepUntil(() => leavesIn(b) > 0);
        session.step(4);

        expect(leavesIn(a)).toBe(1);
        expect(leavesIn(b)).toBe(1);

        const runtimeB = b.client.mirror!.runtime;
        const leaf = [...runtimeB.entities.liveIds()].find(
            (id) => (runtimeB.entities.record(id)?.children.length ?? 0) > 0,
        )!;
        expect(runtimeB.transforms.posY(leaf)).toBeCloseTo(-80, 6);
    });

    it('drifts the leaf rightwards under the server, not the client', async () => {
        session = new Session();
        const tab = await session.join('one');
        session.stepUntil(() => tab.client.state === 'live');

        session.click(tab, 0);
        session.stepUntil(() => leavesIn(tab) > 0);

        const runtime = tab.client.mirror!.runtime;
        const leaf = [...runtime.entities.liveIds()].find(
            (id) => (runtime.entities.record(id)?.children.length ?? 0) > 0,
        )!;
        const before = runtime.transforms.posX(leaf);

        session.step(60);
        const after = runtime.transforms.posX(leaf);

        // A second of travel, allowing for the ticks the envelope spent in flight.
        expect(after - before).toBeGreaterThan(LEAF_SPEED * 0.5);
        expect(after - before).toBeLessThanOrEqual(LEAF_SPEED * 1.2);
        expect(runtime.transforms.rotation(leaf)).not.toBe(0);
    });

    it('retires the leaf on the far side, for every tab', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        session.click(a, 40);
        session.stepUntil(() => leavesIn(a) > 0);

        // 1024 world px of travel plus the margins, with slack for the join and the wire.
        const crossing = Math.ceil(((960 + 2 * EDGE_MARGIN) / LEAF_SPEED) * 60) + 60;
        session.stepUntil(() => leavesIn(a) === 0 && leavesIn(b) === 0, crossing);

        expect(leavesIn(a)).toBe(0);
        expect(leavesIn(b)).toBe(0);
    });

    it('clears every leaf for everyone when one tab asks', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        session.click(a, 100);
        session.click(b, -100);
        session.stepUntil(() => leavesIn(a) >= 1 && leavesIn(b) >= 1);
        session.step(8);
        const before = leavesIn(a);
        expect(before).toBeGreaterThanOrEqual(1);

        b.device.emit({ kind: 'key', code: 'keys:KeyC', down: true });
        b.device.emit({ kind: 'key', code: 'keys:KeyC', down: false });
        session.stepUntil(() => leavesIn(a) === 0);

        expect(leavesIn(a)).toBe(0);
        expect(leavesIn(b)).toBe(0);
    });

    it('keeps a leaf alive after the tab that spawned it disconnects', async () => {
        session = new Session();
        const a = await session.join('a');
        const b = await session.join('b');
        session.stepUntil(() => a.client.state === 'live' && b.client.state === 'live');

        session.click(a, 0);
        session.stepUntil(() => leavesIn(b) > 0);
        session.step(4);
        expect(leavesIn(b)).toBe(1);

        // Leaves are spawned unowned precisely so this does not destroy them: the server sweeps
        // every entity whose ownerId matches a departing player.
        a.client.destroy({ ownsRenderer: true });
        session.step(30);

        expect(leavesIn(b)).toBe(1);
    });

    it('drops no input frame the server would refuse', async () => {
        session = new Session();
        const tab = await session.join('one');
        session.stepUntil(() => tab.client.state === 'live');

        session.click(tab, 200);
        session.step(30);

        // A refused or lost frame stalls the ack and leaves the ring occupied.
        expect(tab.client.stats().ringSize).toBe(0);
        expect(tab.client.stats().state).toBe('live');
        // Nonzero means replication silently dropped something as unrepresentable.
        expect(session.server.droppedMarks).toBe(0);
    });
});

describe('the binding table the browser sends under', () => {
    it('names the codes the device actually emits', () => {
        const codes = BINDINGS.map((b) => b.code);
        expect(codes).toContain(CODE_SPAWN);
        expect(codes).toContain(CODE_AIM_Y);
    });
});

describe('the manifest the server ships', () => {
    it('declares a badge template for every slot a player index can land in', () => {
        const declared = new Set(serverConfig().visuals?.templates.map((t) => t.template));
        for (let index = 0; index < PLAYER_TINTS.length * 3; index++) {
            // A template with no manifest entry silently draws a placeholder rather than failing.
            expect(declared.has(markerTemplate(index))).toBe(true);
        }
        expect(declared.has(LEAF_TEMPLATE)).toBe(true);
    });
});

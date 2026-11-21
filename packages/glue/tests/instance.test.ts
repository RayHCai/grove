// The classes below carry no decorators: vitest's transform does not lower TC39 decorators, and
// this suite is about the ORDER glue puts things in, not what a handler does once dispatched.

import { afterEach, describe, expect, it } from 'vitest';
import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { GameClient } from '@platform/client';
import { ServerScript } from '@platform/core';
import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import { createReadyNullRenderer } from '@platform/renderer/null';
import { ScriptRegistry } from '@platform/scripting';
import type { ScriptEntry } from '@platform/scripting';
import { jsonCodec, loopbackPair } from '@platform/transport';
import type { Codec, EncodedFrame, Message } from '@platform/transport';
import { ClientInstance } from '../src/client/index.js';
import { GameInstance } from '../src/server/index.js';

const TICK = 1 / 60;
const RULES = scriptId('rules');
const PIP = templateId('pip');
const DOT = assetId('dot');

/** Records that the world was actually built, and by whom. */
const constructed: string[] = [];

class Rules extends ServerScript {
    constructor() {
        super();
        constructed.push('rules');
    }
}

function registry(): ScriptRegistry<typeof RULES> {
    const entries: ScriptEntry<typeof RULES>[] = [{ id: RULES, location: 'server', ctor: Rules }];
    return ScriptRegistry.from(entries);
}

function project(): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'glue-test',
        contentHash: '1',
        settings: {
            simRate: 60,
            sendRate: 20,
            maxPlayers: 4,
            bounds: { left: -100, right: 100, top: 100, bottom: -100 },
            regions: [],
        },
        assets: [{ id: DOT, kind: 'texture', url: '/dot.png' }],
        scriptModules: [
            {
                path: 'rules.ts',
                scripts: [{ id: RULES, export: 'Rules', location: 'server', host: 'game' }],
            },
        ],
        templates: [{ id: PIP, visual: { kind: 'sprite', texture: DOT }, scripts: [] }],
        entities: [
            {
                id: 'a-pip',
                template: PIP,
                parent: null,
                transform: { x: 5 },
                tags: [],
                scripts: [],
            },
        ],
        gameScripts: [{ script: RULES }],
    };
}

interface Harness {
    instance: GameInstance;
    session: ClientInstance;
    client: GameClient;
    frames: ManualFrameSource;
    step(ticks: number): Promise<void>;
    dispose(): void;
}

/** Turns the microtask queue six times, enough for an identified join's promise chain. */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** One instance and one client over a loopback pair, on a clock the test turns by hand. */
async function harness(): Promise<Harness> {
    const pair = loopbackPair();
    let now = 0;

    const instance = new GameInstance({
        project: project(),
        scripts: registry(),
        now: () => now,
        // The driver calls this first, every pump, so no test ever orders delivery itself.
        deliver: () => pair.deliver(),
    });
    expect(instance.accept(pair.server, 'someone')).not.toBeNull();

    const renderer = await createReadyNullRenderer({ design: { width: 200, height: 200 } });

    const frames = new ManualFrameSource();
    const session = new ClientInstance({
        transport: pair.client,
        renderer,
        frames,
        device: new ScriptedInputDevice(),
        clock: { nowSeconds: () => now },
        name: 'tester',
        project: project(),
        // The null renderer is this harness's, and nothing else holds it.
        ownsRenderer: true,
    });
    session.start();

    return {
        instance,
        session,
        client: session.client,
        frames,
        async step(ticks: number): Promise<void> {
            for (let i = 0; i < ticks; i++) {
                now += TICK;
                instance.pump();
                frames.frame(now);
                // An identified join awaits a store read before a Player is allocated, so the
                // admission finishes on the microtask queue rather than inside the pump.
                await flushMicrotasks();
            }
        },
        dispose(): void {
            // The session first, for the reason a host disposes its own renderer nodes first: both
            // reach the same renderer, and this one owns it.
            session.close();
            instance.close();
        },
    };
}

let live: Harness | null = null;

afterEach(() => {
    live?.dispose();
    live = null;
    constructed.length = 0;
});

describe('a game instance', () => {
    it('builds the whole world before it will admit anything', async () => {
        const instance = new GameInstance({ project: project(), scripts: registry() });
        // Construction is the boot: the manifest is validated, the registry resolved, the templates
        // built and the placed world instantiated, all before `accept` is reachable.
        expect(instance.sim.booted).toBe(true);
        expect(constructed).toEqual(['rules']);
        const placed = instance.sim.runtime.entities.liveIds();
        expect(placed).toHaveLength(1);
        instance.close();
    });

    it('carries a client all the way to live', async () => {
        live = await harness();
        expect(live.session.state).toBe('connecting');

        for (let i = 0; i < 200 && live.session.state !== 'live'; i++) await live.step(1);

        expect(live.session.state).toBe('live');
        expect(live.client.localPlayer).not.toBeNull();
        // The placed entity reached the mirror, so the manifest the server built from and the one
        // the client claimed are the same file.
        expect(live.client.mirror?.runtime.entities.liveIds()).toHaveLength(1);
    });

    it('starts no clock until it is asked to', () => {
        let ticks = 0;
        const instance = new GameInstance({
            project: project(),
            scripts: registry(),
            now: () => {
                ticks += 1;
                return ticks * TICK;
            },
        });
        // Nothing has read the clock: construction boots a world, it does not run one.
        expect(ticks).toBe(0);
        instance.pump();
        expect(ticks).toBe(1);
        instance.close();
    });

    it('refuses a transport once closed, and closes it rather than leaking it', () => {
        const instance = new GameInstance({ project: project(), scripts: registry() });
        instance.close();

        const pair = loopbackPair();
        let closed = false;
        pair.server.onClose(() => {
            closed = true;
        });

        expect(instance.accept(pair.server, 'late')).toBeNull();
        expect(instance.closed).toBe(true);
        // A loopback end tells its peer on the next drain rather than inside `close()`, so the
        // refusal is observable one delivery later, not never.
        pair.deliver();
        expect(closed).toBe(true);
    });

    it('is idempotent to close, and inert to a pump after one', () => {
        let reads = 0;
        const instance = new GameInstance({
            project: project(),
            scripts: registry(),
            now: () => ++reads * TICK,
        });
        instance.close();
        instance.close();
        instance.pump();
        expect(reads).toBe(0);
    });

    it('refuses a project the validator rejects, rather than booting a broken world', () => {
        const broken = project();
        // A template attachment naming a script no module declares: the file is the claim, and
        // `createServer` checks it before anything is built.
        broken.templates = [
            { id: PIP, visual: { kind: 'sprite', texture: DOT }, scripts: [{ script: RULES }] },
        ];
        expect(() => new GameInstance({ project: broken, scripts: registry() })).toThrow(
            /game-hosted and cannot attach to a entity|is game-hosted/,
        );
    });
});

/** The JSON codec, except that it refuses whichever envelope kind the test names. */
class RefusingCodec implements Codec {
    refuse: string | null = null;

    encode(message: Message): EncodedFrame {
        if ((message as { kind?: unknown }).kind === this.refuse) throw new Error('refused');
        return jsonCodec.encode(message);
    }

    decode(frame: Parameters<Codec['decode']>[0]): Message {
        return jsonCodec.decode(frame);
    }

    byteLength(frame: Parameters<Codec['byteLength']>[0]): number {
        return jsonCodec.byteLength(frame);
    }
}

describe('a shared envelope the codec refuses', () => {
    async function twoPeers(codec: Codec): Promise<{
        instance: GameInstance;
        sessions: ClientInstance[];
        lines: string[];
        step(ticks: number): Promise<void>;
        dispose(): void;
    }> {
        let now = 0;
        const lines: string[] = [];
        const pairs = [loopbackPair(), loopbackPair()];
        const instance = new GameInstance({
            project: project(),
            scripts: registry(),
            codec,
            now: () => now,
            deliver: () => {
                for (const pair of pairs) pair.deliver();
            },
            onLog: (line) => lines.push(line),
        });
        const frames: ManualFrameSource[] = [];
        const sessions: ClientInstance[] = [];
        for (const [at, pair] of pairs.entries()) {
            instance.accept(pair.server, `p${at}`);
            const source = new ManualFrameSource();
            frames.push(source);
            const renderer = await createReadyNullRenderer({ design: { width: 200, height: 200 } });
            const session = new ClientInstance({
                transport: pair.client,
                renderer,
                frames: source,
                device: new ScriptedInputDevice(),
                clock: { nowSeconds: () => now },
                name: `p${at}`,
                project: project(),
                ownsRenderer: true,
            });
            session.start();
            sessions.push(session);
        }
        const step = async (ticks: number): Promise<void> => {
            for (let i = 0; i < ticks; i++) {
                now += TICK;
                instance.pump();
                for (const source of frames) source.frame(now);
                await flushMicrotasks();
            }
        };
        for (let i = 0; i < 200 && sessions.some((s) => s.state !== 'live'); i++) await step(1);
        return {
            instance,
            sessions,
            lines,
            step,
            dispose(): void {
                for (const session of sessions) session.close();
                instance.close();
            },
        };
    }

    it('is logged once per send and skipped when droppable, closing nobody', async () => {
        const codec = new RefusingCodec();
        const world = await twoPeers(codec);
        expect(world.sessions.map((s) => s.state)).toEqual(['live', 'live']);
        codec.refuse = 'transform';
        await world.step(6);

        // One line per send, never one per peer.
        const refused = world.lines.filter((l) => l.startsWith('send-unencodable'));
        expect(refused.length).toBeGreaterThan(0);
        for (const line of refused) expect(line).toMatch(/kind=transform peers=2/);
        expect(world.lines.filter((l) => l.includes('send-failed'))).toEqual([]);
        expect(world.sessions.map((s) => s.state)).toEqual(['live', 'live']);
        world.dispose();
    });

    it('is logged once and closes every recipient when reliable, since each would diverge', async () => {
        const codec = new RefusingCodec();
        const world = await twoPeers(codec);
        // Refused only after the declaration, which the sim checks against this same codec.
        world.instance.declareVisuals({
            assets: [],
            templates: [{ template: templateId('gem'), kind: 'sprite', texture: DOT }],
        });
        codec.refuse = 'manifest';
        await world.step(6);

        const refused = world.lines.filter((l) => l.startsWith('send-unencodable'));
        expect(refused).toEqual([expect.stringMatching(/kind=manifest peers=2/)]);
        expect(world.lines.filter((l) => l.includes('send-failed'))).toEqual([]);
        expect(world.sessions.map((s) => s.state)).not.toContain('live');
        world.dispose();
    });
});

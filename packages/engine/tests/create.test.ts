// The composition roots, driven the way a host drives them: one project file, one loopback pair,
// and a session that reaches `live` running the world the manifest described.
//
// Both ends are built from the SAME manifest and the same registry, which is the single-process
// local-play arrangement and the one that makes a disagreement between the two derivations visible.

import { describe, expect, it } from 'vitest';
import { ClientScript, ServerScript } from '@platform/core';
import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { GameClient } from '@platform/client';
import { PROJECT_FORMAT_VERSION, assetId, scriptId, templateId } from '@platform/project';
import { createNullRenderer } from '@platform/renderer/null';
import { ScriptRegistry } from '@platform/scripting';
import type { ScriptEntry } from '@platform/scripting';
import { loopbackPair } from '@platform/transport';
import { createClient, createServer } from '../src/host/index.js';
import type { ProjectManifest } from '../src/host/index.js';

const TICK = 1 / 60;

const COIN = templateId('coin');
const COIN_TEXTURE = assetId('coin-texture');
const RULES = scriptId('rules');
const SPARKLE = scriptId('sparkle');
const LOOT = scriptId('loot');

/** Every construction this process performs, so a test can say which side wired what. */
const constructed: string[] = [];

/** Game-hosted and server-located: `gameScripts` is the path createServer resolves it through. */
class Rules extends ServerScript {
    constructor() {
        super();
        constructed.push('rules');
    }
}

/** On the coin template, client-located — so the mirror attaches it and the authority's copy is inert. */
class Sparkle extends ClientScript {
    constructor() {
        super();
        constructed.push('sparkle');
    }
}

/** On the same template, server-located: authoritative code that must never reach the mirror. */
class Loot extends ServerScript {
    constructor() {
        super();
        constructed.push('loot');
    }
}

function registry(): ScriptRegistry<typeof RULES> {
    const entries: ScriptEntry<typeof RULES>[] = [
        { id: RULES, location: 'server', ctor: Rules },
        { id: SPARKLE, location: 'client', ctor: Sparkle },
        { id: LOOT, location: 'server', ctor: Loot },
    ];
    return ScriptRegistry.from(entries);
}

function project(over: Partial<ProjectManifest> = {}): ProjectManifest {
    return {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'grove-demo',
        contentHash: 'sha256-of-what-was-authored',
        settings: {
            simRate: 60,
            sendRate: 20,
            // Neither is core's default, so a session carrying them proves they came off the file.
            maxPlayers: 4,
            bounds: { left: -200, right: 200, top: 150, bottom: -150 },
            regions: [{ name: 'pit', bounds: { left: -50, right: 50, top: 50, bottom: -50 } }],
        },
        assets: [{ id: COIN_TEXTURE, kind: 'texture', url: 'https://assets.test/coin.png' }],
        scriptModules: [
            {
                path: 'src/server/rules.ts',
                scripts: [{ id: RULES, export: 'Rules', location: 'server', host: 'game' }],
            },
            {
                path: 'src/coin.ts',
                scripts: [
                    { id: SPARKLE, export: 'Sparkle', location: 'client', host: 'entity' },
                    { id: LOOT, export: 'Loot', location: 'server', host: 'entity' },
                ],
            },
        ],
        templates: [
            {
                id: COIN,
                visual: { kind: 'sprite', texture: COIN_TEXTURE },
                scripts: [{ script: SPARKLE }, { script: LOOT }],
            },
        ],
        entities: [
            {
                id: 'placed-coin',
                template: COIN,
                parent: null,
                transform: { x: 30, y: -12 },
                tags: ['pickup'],
                scripts: [],
            },
        ],
        gameScripts: [{ script: RULES }],
        ...over,
    };
}

interface Session {
    client: GameClient;
    /** What the authority wired at boot, taken before the client existed. */
    booted: string[];
    /** Runs `n` display frames, pumping the authority once per frame. */
    run(n: number): void;
    /** Frames until the session settles, so a test asserts on a state rather than on a tick count. */
    settle(limit?: number): void;
    close(): void;
}

async function session(
    server = project(),
    client = server,
    opts: { predict?: boolean } = {},
): Promise<Session> {
    const pair = loopbackPair({ latency: 1 });
    const shared = registry();

    constructed.length = 0;
    const authority = createServer(server, pair.server, {
        scripts: shared,
        deliver: () => pair.deliver(),
    });
    const booted = constructed.splice(0);

    const renderer = createNullRenderer();
    await renderer.init({ container: {} as never, design: { width: 800, height: 600 } });

    const frames = new ManualFrameSource();
    let now = 0;
    const viewer = createClient({
        transport: pair.client,
        renderer,
        frames,
        device: new ScriptedInputDevice(),
        clock: { nowSeconds: () => now },
        name: 'ray',
        project: client,
        scripts: shared,
        pump: () => pair.deliver(),
        ...(opts.predict === undefined ? {} : { predict: opts.predict }),
    });
    viewer.start();

    const run = (n: number): void => {
        for (let i = 0; i < n; i++) {
            now += TICK;
            authority.pump(now);
            frames.frame(now);
        }
    };

    return {
        client: viewer,
        booted,
        run,
        settle(limit = 120): void {
            for (let i = 0; i < limit; i++) {
                run(1);
                if (viewer.state === 'live' || viewer.state === 'failed') return;
            }
            throw new Error(`the session was still ${viewer.state} after ${limit} frames`);
        },
        close(): void {
            viewer.destroy();
            authority.close();
        },
    };
}

describe('createServer and createClient', () => {
    it('stand up a session over a loopback pair', async () => {
        const s = await session();
        s.settle();

        expect(s.client.state).toBe('live');
        expect(s.client.localPlayer?.name).toBe('ray');
        s.close();
    });

    it('build the world the manifest describes, not the engine defaults', async () => {
        const s = await session();
        s.settle();

        // Off the file and through the wire: the client never read the manifest for these.
        const runtime = s.client.mirror?.runtime;
        expect(runtime?.worldBounds).toEqual({ left: -200, right: 200, top: 150, bottom: -150 });
        expect(runtime?.simRate).toBe(60);
        // The placed entity, instantiated at boot and carried in the welcome's snapshot.
        expect(s.client.stats().nodeCount).toBeGreaterThan(0);
        s.close();
    });

    it('wire what the project attached, on the side that runs it', async () => {
        const s = await session();
        // The Game-hosted class, resolved out of the registry by `gameScripts`.
        expect(s.booted).toContain('rules');

        s.settle();
        // The mirror attached the client-located class off the snapshot's attachments and skipped
        // the server-located one, which the authority alone runs.
        const mirrored = constructed.splice(0);
        expect(mirrored).toContain('sparkle');
        expect(mirrored).not.toContain('loot');
        expect(s.client.mirror?.counters.droppedAttach).toBe(0);
        s.close();
    });

    it('derive one identity from one manifest, so a different project is refused', async () => {
        const other = project({ projectId: 'some-other-game' });
        const s = await session(project(), other);
        s.settle();

        expect(s.client.state).toBe('failed');
        expect(s.client.lifecycle.failure?.kind).toBe('rejected');
        s.close();
    });

    it('admit a client whose manifest matches but whose content hash does not, never', async () => {
        const drifted = project({ contentHash: 'sha256-of-something-else' });
        const s = await session(project(), drifted);
        s.settle();

        expect(s.client.state).toBe('failed');
        expect(s.client.lifecycle.failure?.kind).toBe('rejected');
        s.close();
    });
});

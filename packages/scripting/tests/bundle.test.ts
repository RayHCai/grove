// The acceptance gate for the pipeline. The assertion that matters most is the metadata one: if the
// bundler had run over source instead of over tsc's lowered output, the decorators would reach the
// chunk verbatim and every table below would be empty.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ScriptRegistry } from '../src/registry.js';
import type { ScriptChunkModule } from '../src/registry.js';
import { buildScriptBundle } from '../src/toolchain/index.js';
import type { ScriptBundle } from '../src/toolchain/index.js';
import { FIXTURES, scratch } from './helpers.js';

const PROJECT = path.join(FIXTURES, 'project');

function build(name: string): Promise<ScriptBundle> {
    const root = scratch(name);
    return buildScriptBundle({
        tsconfig: path.join(PROJECT, 'tsconfig.json'),
        srcDir: path.join(PROJECT, 'src'),
        loweredDir: path.join(root, 'lowered'),
        outDir: path.join(root, 'out'),
    });
}

let bundle: ScriptBundle;
let outDir: string;

beforeAll(async () => {
    outDir = path.join(scratch('once'), 'out');
    bundle = await buildScriptBundle({
        tsconfig: path.join(PROJECT, 'tsconfig.json'),
        srcDir: path.join(PROJECT, 'src'),
        loweredDir: path.join(path.dirname(outDir), 'lowered'),
        outDir,
    });
});

describe('the two-side bundle', () => {
    it('stamps an id on every exported script class', () => {
        expect(bundle.scripts.map((s) => s.id)).toEqual([
            'client/hud#Clock',
            'server/router#default',
            'server/rules#Rules',
            'synced/runner#Runner',
        ]);
    });

    it('sends server and synced one way, client and synced the other', () => {
        expect(bundle.server.scripts).toEqual([
            'server/router#default',
            'server/rules#Rules',
            'synced/runner#Runner',
        ]);
        expect(bundle.client.scripts).toEqual(['client/hud#Clock', 'synced/runner#Runner']);
    });

    it('keeps a ServerScript out of the client chunk, and a ClientScript out of the server one', () => {
        expect(bundle.client.code).not.toContain('server/rules.js');
        expect(bundle.client.code).not.toContain('Rules');
        expect(bundle.server.code).not.toContain('client/hud.js');
        expect(bundle.server.code).not.toContain('Clock');
    });

    it('leaves the runtime packages external, for the evaluation boundary to resolve', () => {
        expect(bundle.server.imports).toEqual(['@platform/core']);
        expect(bundle.client.imports).toEqual(['@platform/core']);
    });

    it('names each file by its own hash', () => {
        expect(bundle.server.fileName).toBe(`server-${bundle.server.hash.slice(0, 16)}.js`);
        expect(bundle.client.fileName).toBe(`client-${bundle.client.hash.slice(0, 16)}.js`);
        expect(bundle.server.hash).not.toBe(bundle.client.hash);
    });
});

describe('the content hash', () => {
    it('is the same bytes from the same source, through different directories', async () => {
        const [first, second] = await Promise.all([build('hash-a'), build('hash-b')]);
        expect(first.server.code).toBe(second.server.code);
        expect(first.server.hash).toBe(second.server.hash);
        expect(first.client.hash).toBe(second.client.hash);
        // What a handshake compares: the two sides differ by construction, the synced half must not.
        expect(first.syncedHash).toBe(second.syncedHash);
    });

    it('is not either side chunk, because those two can never agree', () => {
        expect(bundle.syncedHash).not.toBe(bundle.server.hash);
        expect(bundle.syncedHash).not.toBe(bundle.client.hash);
    });

    it('carries no absolute path into the hashed bytes', () => {
        expect(bundle.server.code).not.toContain(PROJECT);
        expect(bundle.server.code).not.toContain('\\');
        expect(bundle.server.code).not.toContain('\r');
    });
});

describe('the chunk a registry is built from', () => {
    it('resolves an id to its class, and the class back to its id', async () => {
        const registry = await load('server');
        const runner = registry.resolve('synced/runner#Runner');
        expect(runner?.name).toBe('Runner');
        expect(registry.idOf(runner!)).toBe('synced/runner#Runner');
        expect(registry.locationOf('synced/runner#Runner')).toBe('synced');
    });

    it('finds the decorator metadata intact — the lowering survived the bundler', async () => {
        const registry = await load('server');
        const metadata = registry.metadataOf('synced/runner#Runner');
        expect(metadata?.handlers.map((h) => [h.kind, h.event, h.methodName])).toEqual([
            ['onUpdate', '@update', 'advance'],
        ]);
        expect([...(metadata?.state ?? [])]).toEqual(['x']);

        expect(registry.metadataOf('server/router#default')?.handlers).toEqual([
            { event: 'ping', kind: 'onRequest', methodName: 'ping', opts: {} },
        ]);
    });

    it('says which side it was linked for', async () => {
        expect((await chunk('server')).side).toBe('server');
        expect((await chunk('client')).side).toBe('client');
    });
});

async function chunk(side: 'client' | 'server'): Promise<ScriptChunkModule> {
    const file = side === 'server' ? bundle.server.fileName : bundle.client.fileName;
    return (await import(pathToFileURL(path.join(outDir, file)).href)) as ScriptChunkModule;
}

async function load(side: 'client' | 'server'): Promise<ScriptRegistry> {
    return ScriptRegistry.from((await chunk(side)).scripts);
}

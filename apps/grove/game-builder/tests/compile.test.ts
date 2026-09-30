// The server half a build produces, evaluated the way a session's isolate evaluates it: one
// classic script in a realm of its own, driven through the entry it publishes.

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { PLAYER_SOURCE, projectJson } from './doubles.js';

/** A real compile spawns tsc and two bundlers, which is seconds rather than milliseconds. */
const COMPILES = 120_000;

interface Entry {
    boot(config: string): void;
    tick(batch: string): string;
}

function idle(nowMs: number, drain = false) {
    return {
        nowMs,
        drain,
        opened: [] as unknown[],
        frames: [] as unknown[],
        closed: [],
        records: [],
        saved: [],
    };
}

/** The wire version the bundled sim speaks, read from the copy it was linked against. */
async function protocolVersion(): Promise<number> {
    const sim = fileURLToPath(import.meta.resolve('@platform/sim'));
    const root = realpathSync(path.join(sim, '../../node_modules/@platform/protocol'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        exports: { '.': { import: string } };
    };
    const protocol = (await import(
        pathToFileURL(path.join(root, manifest.exports['.'].import)).href
    )) as { PROTOCOL_VERSION: number };
    return protocol.PROTOCOL_VERSION;
}

describe('the server half', () => {
    it(
        'leaves its realm unguarded, and boots and ticks',
        async () => {
            const compiled = await compile('compile-test-shim', [
                { path: 'project.json', text: projectJson() },
                { path: 'src/player.ts', text: PLAYER_SOURCE },
            ]);
            if (compiled.outcome !== 'compiled') throw new Error(JSON.stringify(compiled));

            const realm = vm.createContext({});
            vm.runInContext(compiled.output.server.toString('utf8'), realm);
            const entry = vm.runInContext('globalThis.__grove', realm) as Entry;

            // The realm also runs ServerScripts, which may read a clock, so it carries no shim.
            expect(() => vm.runInContext('Date.now()', realm)).not.toThrow();
            expect(() => vm.runInContext('Math.random()', realm)).not.toThrow();

            entry.boot(JSON.stringify({ simRate: 30, sendRate: 15 }));
            const tick = (batch: ReturnType<typeof idle>) =>
                JSON.parse(entry.tick(JSON.stringify(batch))) as {
                    tick: number;
                    sends: { envelope: string }[];
                    log: { level: string; line: string }[];
                };

            // A join runs the game's own @onPlayerJoin, which is where a clock read would throw.
            const opened = idle(0);
            opened.opened.push({ connectionId: 'c1', identity: null });
            opened.frames.push({
                connectionId: 'c1',
                message: {
                    kind: 'join-request',
                    protocolVersion: await protocolVersion(),
                    name: 'anon',
                    clientSentMs: 1000,
                    projectId: 'leaf-harvest',
                    projectHash: 'b'.repeat(64),
                    bundleHash: '',
                },
            });
            const outs = [tick(opened)];
            for (let at = 1; at < 16; at++) outs.push(tick(idle(at * 33, at % 3 === 2)));

            expect(outs[0]?.tick).toBe(1);
            const kinds = outs.flatMap((out) =>
                out.sends.map((send) => (JSON.parse(send.envelope) as { kind: string }).kind),
            );
            expect(kinds).toContain('welcome');
            expect(outs.flatMap((out) => out.log).filter((line) => line.level === 'error')).toEqual(
                [],
            );
        },
        COMPILES,
    );

    it(
        'leaves a compile tsc did not finish in time for another attempt, not the creator',
        async () => {
            const compiled = await compile(
                'compile-test-deadline',
                [
                    { path: 'project.json', text: projectJson() },
                    { path: 'src/player.ts', text: PLAYER_SOURCE },
                ],
                1,
            );
            expect(compiled).toMatchObject({ outcome: 'unavailable' });
            expect(compiled.outcome === 'unavailable' && compiled.message).toMatch(
                /did not finish/u,
            );
        },
        COMPILES,
    );
});

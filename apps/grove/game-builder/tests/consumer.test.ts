// What a build box does with one claimed task: what it compiles, what it writes back, and which
// failures leave the message for another box to take.

import { describe, expect, it } from 'vitest';
import { MAX_TASK_MESSAGE, TaskStatusUpdate } from '@grove/api-contract';
import { runBuild } from '../src/consumer.js';
import type { Builder } from '../src/consumer.js';
import { readEnv } from '../src/env.js';
import {
    CLAIMED,
    GAME_ID,
    PLAYER_SOURCE,
    REVISION,
    TASK_ID,
    UNDETERMINED_SOURCE,
    holding,
    projectJson,
    quiet,
    silent,
    writing,
} from './doubles.js';

/** A real compile spawns tsc and two bundlers, which is seconds rather than milliseconds. */
const COMPILES = 120_000;

const env = readEnv({
    BUILDER_SECRET: 'c'.repeat(32),
    API_URL: 'http://api.grove.internal:4000',
});

function game(source: string): Record<string, string> {
    return { 'project.json': projectJson(), 'src/player.ts': source };
}

/** The server half a build stored, by the name it chose for it. */
function serverOf(store: ReturnType<typeof holding>): string | undefined {
    return [...store.stored.keys()].find((name) => name.startsWith('server-'));
}

/** A beginner's dozen: every line a different value its declared type refuses. */
const TYPE_ERRORS = Array.from(
    { length: 12 },
    (_, at) => `export const wrong${String(at)}: number = 'not a number ${String(at)}';`,
).join('\n');

describe('a claimed build', () => {
    it(
        'compiles the pinned revision and settles it with what it produced',
        async () => {
            const tasks = writing();
            const store = holding(game(PLAYER_SOURCE));
            const builder: Builder = { tasks, store, env, log: quiet() };

            expect(await runBuild(TASK_ID, builder)).toBe('settled');
            expect(tasks.wrote[0]).toEqual({ status: 'IN_PROGRESS' });
            const settled = TaskStatusUpdate.parse(tasks.wrote[1]);
            expect(settled.status).toBe('SUCCESSFUL');

            // Three outputs, and the settle that names them is the commit.
            const names = [...store.stored.keys()];
            expect(names.slice(0, 2)).toEqual(['client.js', 'simConfig.json']);
            expect(names[2]).toMatch(/^server-[0-9a-f]{32}\.js$/u);
            expect(settled.detail?.build).toMatchObject({ gameId: GAME_ID, revision: REVISION });
            expect(settled.detail?.fileCount).toBe(3);
        },
        COMPILES,
    );

    it(
        "names the server half so no joiner derives it from the client's address",
        async () => {
            const first = holding(game(PLAYER_SOURCE));
            const second = holding(game(PLAYER_SOURCE));
            await runBuild(TASK_ID, { tasks: writing(), store: first, env, log: quiet() });
            await runBuild(TASK_ID, { tasks: writing(), store: second, env, log: quiet() });

            expect(serverOf(first)).not.toBe(serverOf(second));
        },
        COMPILES,
    );

    it(
        'tells the world where the half a joiner fetches is, and what it hashes to',
        async () => {
            const tasks = writing();
            const store = holding(game(PLAYER_SOURCE));
            await runBuild(TASK_ID, { tasks, store, env, log: quiet() });

            const config = JSON.parse(store.stored.get('simConfig.json')?.toString('utf8') ?? '{}');
            const built = TaskStatusUpdate.parse(tasks.wrote[1]).detail?.build;
            // The handshake compares these, so a config naming anything else would admit nobody.
            expect(config.project.bundleHash).toBe(built?.bundles.client.hash);
            expect(config.project.bundleUrl).toBe(built?.bundles.client.url);
            expect(config.simRate).toBe(30);
            expect(config.sendRate).toBe(15);
        },
        COMPILES,
    );

    it(
        'fails the build on source a SyncedScript may not run, and never retries it',
        async () => {
            const tasks = writing();
            const store = holding(game(UNDETERMINED_SOURCE));

            expect(await runBuild(TASK_ID, { tasks, store, env, log: quiet() })).toBe('settled');
            expect(tasks.wrote[1]?.status).toBe('FAILED');
            // Positioned, because the creator has to be able to open the line it names.
            expect(tasks.wrote[1]?.detail?.diagnostics?.[0]).toMatchObject({
                severity: 'error',
                file: 'src/player.ts',
            });
            expect(store.stored.size).toBe(0);
        },
        COMPILES,
    );

    // A compiler's log past the bound is a settle the API refuses: a failure with no reason given.
    it(
        'fails a dozen type errors with a short summary, each one positioned, and no path into this box',
        async () => {
            const tasks = writing();
            const store = holding(game(`${PLAYER_SOURCE}\n${TYPE_ERRORS}\n`));

            expect(await runBuild(TASK_ID, { tasks, store, env, log: quiet() })).toBe('settled');
            const failed = TaskStatusUpdate.parse(tasks.wrote[1]);
            expect(failed.status).toBe('FAILED');
            expect(failed.detail?.message).toBe('the game does not typecheck: 12 errors');
            expect(failed.detail?.diagnostics).toHaveLength(12);
            expect(failed.detail?.diagnostics?.[0]).toMatchObject({
                severity: 'error',
                file: 'src/player.ts',
            });
            const written = JSON.stringify(failed);
            expect(written).not.toMatch(/\.builds|game-builder|[A-Za-z]:[\\/]/u);
            expect(written.length).toBeLessThan(64 * 1024);
        },
        COMPILES,
    );

    it(
        'fails the build on a manifest that is not a project this build can read',
        async () => {
            const tasks = writing();
            const store = holding({ 'project.json': '{ not json', 'src/player.ts': PLAYER_SOURCE });

            expect(await runBuild(TASK_ID, { tasks, store, env, log: quiet() })).toBe('settled');
            expect(tasks.wrote[1]?.status).toBe('FAILED');
        },
        COMPILES,
    );

    it('reads a large game a few sources at a time rather than one after another', async () => {
        const files: Record<string, string> = {};
        for (let at = 0; at < 40; at += 1) files[`src/f${String(at)}.ts`] = 'export {};';
        const store = holding(files, 5);
        // No project.json, so the build is refused once the sources are in: only the reads count.
        await runBuild(TASK_ID, { tasks: writing(), store, env, log: quiet() });
        expect(store.widest()).toBeGreaterThan(1);
        expect(store.widest()).toBeLessThanOrEqual(8);
    });

    it('is acknowledged when it was already settled, or it comes back forever', async () => {
        const tasks = writing({ outcome: 'refused' });
        expect(await runBuild(TASK_ID, { tasks, store: silent(), env, log: quiet() })).toBe(
            'settled',
        );
        expect(tasks.wrote).toHaveLength(1);
    });

    it('is left for another box when the claim could not be written down', async () => {
        const tasks = writing({ outcome: 'unavailable' });
        expect(await runBuild(TASK_ID, { tasks, store: silent(), env, log: quiet() })).toBe(
            'retry',
        );
    });

    it('is left for another box when the source could not be read', async () => {
        const tasks = writing();
        expect(await runBuild(TASK_ID, { tasks, store: silent(), env, log: quiet() })).toBe(
            'retry',
        );
        expect(tasks.wrote).toHaveLength(1);
    });

    // A settle the API refuses as malformed is a contract bug, and retrying it rebuilds forever.
    it('writes a minimal failure in place of a settle the API refused, and acknowledges it', async () => {
        const log = quiet();
        const spent = { ...CLAIMED, attempts: env.BUILD_ATTEMPTS + 1 };
        const tasks = writing({ outcome: 'settled', task: spent }, { outcome: 'invalid' });

        expect(await runBuild(TASK_ID, { tasks, store: silent(), env, log })).toBe('settled');
        expect(tasks.wrote).toHaveLength(3);
        expect(tasks.wrote[2]).toMatchObject({
            status: 'FAILED',
            detail: { message: expect.any(String) },
        });
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('keeps a failure it reports inside the bound the API holds it to', async () => {
        const spent = { ...CLAIMED, attempts: env.BUILD_ATTEMPTS };
        const tasks = writing({ outcome: 'settled', task: spent });
        const store = { ...silent(), manifest: async () => ({ outcome: 'unavailable' as const }) };
        await runBuild(TASK_ID, { tasks, store, env, log: quiet() });
        expect(tasks.wrote[1]?.detail?.message?.length ?? 0).toBeLessThanOrEqual(MAX_TASK_MESSAGE);
    });

    it('gives up rather than rebuilding forever once the attempts are spent', async () => {
        const spent = { ...CLAIMED, attempts: env.BUILD_ATTEMPTS };
        const tasks = writing({ outcome: 'settled', task: spent });

        expect(await runBuild(TASK_ID, { tasks, store: silent(), env, log: quiet() })).toBe(
            'settled',
        );
        expect(tasks.wrote[1]?.status).toBe('FAILED');
        // No diagnostics, because nothing was ever said about the source: this is the fleet.
        expect(tasks.wrote[1]?.detail?.diagnostics).toBeUndefined();
    });
});

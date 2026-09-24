// What a build box does with one claimed task: what it compiles, what it writes back, and which
// failures leave the message for another box to take.

import { describe, expect, it } from 'vitest';
import { BuildManifest } from '@grove/api-contract';
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
    FLEET_SECRET: 'c'.repeat(32),
    API_URL: 'http://api.grove.internal:4000',
});

function game(source: string): Record<string, string> {
    return { 'project.json': projectJson(), 'src/player.ts': source };
}

describe('a claimed build', () => {
    it(
        'compiles the pinned revision and settles it with what it produced',
        async () => {
            const tasks = writing();
            const store = holding(game(PLAYER_SOURCE));
            const builder: Builder = { tasks, store, env, log: quiet() };

            expect(await runBuild(TASK_ID, builder)).toBe('settled');
            expect(tasks.wrote[0]).toEqual({ status: 'IN_PROGRESS' });
            expect(tasks.wrote[1]?.status).toBe('SUCCESSFUL');

            // Four files, and the manifest last: everything before it is inert until it names them.
            expect([...store.stored.keys()]).toEqual([
                'client.js',
                'simConfig.json',
                'server.js',
                'build.json',
            ]);
        },
        COMPILES,
    );

    it(
        'writes a build manifest naming the revision it was pinned to',
        async () => {
            const store = holding(game(PLAYER_SOURCE));
            await runBuild(TASK_ID, { tasks: writing(), store, env, log: quiet() });

            const written = BuildManifest.parse(
                JSON.parse(store.stored.get('build.json')?.toString('utf8') ?? '{}'),
            );
            expect(written.gameId).toBe(GAME_ID);
            expect(written.revision).toBe(REVISION);
            expect(written.bundles.server.side).toBe('server');
            expect(written.bundles.client.side).toBe('client');
        },
        COMPILES,
    );

    it(
        'tells the world where the half a joiner fetches is, and what it hashes to',
        async () => {
            const store = holding(game(PLAYER_SOURCE));
            await runBuild(TASK_ID, { tasks: writing(), store, env, log: quiet() });

            const config = JSON.parse(store.stored.get('simConfig.json')?.toString('utf8') ?? '{}');
            const built = BuildManifest.parse(
                JSON.parse(store.stored.get('build.json')?.toString('utf8') ?? '{}'),
            );
            // The handshake compares these, so a config naming anything but the stored client half
            // would admit nobody.
            expect(config.project.bundleHash).toBe(built.bundles.client.hash);
            expect(config.project.bundleUrl).toBe(built.bundles.client.url);
            // What a Rust host reads off this file, which no box may supply instead.
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
            // Nothing was stored: a refusal comes before anything is written.
            expect(store.stored.size).toBe(0);
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

    it('is acknowledged when it was already settled, or it comes back forever', async () => {
        const tasks = writing({ outcome: 'refused' });
        const builder: Builder = { tasks, store: silent(), env, log: quiet() };

        expect(await runBuild(TASK_ID, builder)).toBe('settled');
        // Nothing was written past the claim: the claim itself was refused.
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
        // Only the claim: an outcome would be a verdict on a game this box never saw.
        expect(tasks.wrote).toHaveLength(1);
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

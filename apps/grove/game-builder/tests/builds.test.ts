// The surface a creator's editor polls, and what the queue does to a job while it polls.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BuildJob } from '@grove/api-contract';
import type { BuildDiagnostic, BundleSet } from '@grove/api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { readEnv } from '../src/env.js';
import { InMemoryJobQueue } from '../src/pipeline.js';
import type { BuildOutcome, Compiler, JobQueue } from '../src/pipeline.js';

const SECRET = 'e'.repeat(32);
const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const OTHER_GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const UNKNOWN_JOB_ID = '5b2f7cbe-6d1a-4f7d-9d4a-1b8d2c3e4f50';
const SOURCE_HASH = 'a3f1'.repeat(16);
const SERVER_HASH = 'b7c2'.repeat(16);
const CLIENT_HASH = 'c8d3'.repeat(16);

const env = readEnv({
    NODE_ENV: 'test',
    FLEET_SECRET: SECRET,
    UPLOAD_SERVICE_URL: 'http://127.0.0.1:4005',
    GAME_MANAGER_URL: 'http://127.0.0.1:4001',
});

const bearer = { authorization: `Bearer ${SECRET}` };

const bundles: BundleSet = {
    server: {
        side: 'server',
        hash: SERVER_HASH,
        url: `https://objects.grove.example/o/${SERVER_HASH}`,
        byteLength: 81_920,
    },
    client: {
        side: 'client',
        hash: CLIENT_HASH,
        url: `https://objects.grove.example/o/${CLIENT_HASH}`,
        byteLength: 65_536,
    },
    syncedHash: SOURCE_HASH,
};

const diagnostics: BuildDiagnostic[] = [
    { severity: 'error', file: 'src/enemy.ts', line: 12, column: 5, message: 'no such name' },
];

/**
 * Lets the queue run to a standstill.
 *
 * One `setImmediate` is not it: settling a build resolves a promise whose continuation queues
 * another, so the number of turns between a resolve and the recorded state is an implementation
 * detail. Draining until the loop is idle makes the wait independent of how loaded the machine is,
 * which is what a single tick was not.
 */
async function drained(): Promise<void> {
    for (let turn = 0; turn < 64; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** A toolchain the test holds open, so a job's state is whatever the test has let happen so far. */
function heldToolchain(): { compiler: Compiler; settle: (outcome: BuildOutcome) => Promise<void> } {
    const holding: ((outcome: BuildOutcome) => void)[] = [];
    return {
        compiler: { compile: () => new Promise<BuildOutcome>((resolve) => holding.push(resolve)) },
        settle: async (outcome) => {
            holding.shift()?.(outcome);
            await drained();
        },
    };
}

async function queueBuild(app: FastifyInstance, gameId: string = GAME_ID): Promise<BuildJob> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/builds',
        headers: bearer,
        payload: { gameId, sourceHash: SOURCE_HASH },
    });
    expect(response.statusCode).toBe(202);
    return BuildJob.parse(response.json());
}

async function readBuild(app: FastifyInstance, jobId: string): Promise<BuildJob> {
    const response = await app.inject({
        method: 'GET',
        url: `/v1/builds/${jobId}`,
        headers: bearer,
    });
    expect(response.statusCode).toBe(200);
    return BuildJob.parse(response.json());
}

describe('the fleet bearer', () => {
    it('lets a liveness poll through without one', async () => {
        const app = await buildApp(env);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
    });

    it('refuses a build with no bearer at all', async () => {
        const app = await buildApp(env);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            payload: { gameId: GAME_ID, sourceHash: SOURCE_HASH },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('unauthorized');
    });

    it('refuses a bearer of the right length that is not the secret', async () => {
        const app = await buildApp(env);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/builds/${UNKNOWN_JOB_ID}`,
            headers: { authorization: `Bearer ${'f'.repeat(SECRET.length)}` },
        });
        expect(response.statusCode).toBe(401);
    });
});

describe('queueing a build', () => {
    it('answers 202 with the job in its queued state', async () => {
        const app = await buildApp(env);
        const job = await queueBuild(app);
        expect(job.state).toBe('queued');
        expect(job.gameId).toBe(GAME_ID);
        expect(job.diagnostics).toEqual([]);
        expect(job.startedAt).toBeUndefined();
        expect(job.bundles).toBeUndefined();
    });

    it('rejects a source hash the object store could never have named', async () => {
        const app = await buildApp(env);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            headers: bearer,
            payload: { gameId: GAME_ID, sourceHash: 'the-latest-one' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('invalid_request');
    });
});

describe('a job under the toolchain', () => {
    let toolchain: ReturnType<typeof heldToolchain>;
    let queue: JobQueue;

    beforeEach(() => {
        toolchain = heldToolchain();
        queue = new InMemoryJobQueue(toolchain.compiler);
    });

    it('runs one build while the next waits its turn', async () => {
        const app = await buildApp(env, queue);
        const first = await queueBuild(app);
        const second = await queueBuild(app);

        expect((await readBuild(app, first.jobId)).state).toBe('running');
        expect((await readBuild(app, second.jobId)).state).toBe('queued');
    });

    it('carries the bundle set a success registered', async () => {
        const app = await buildApp(env, queue);
        const queued = await queueBuild(app);
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });

        const job = await readBuild(app, queued.jobId);
        expect(job.state).toBe('succeeded');
        expect(job.bundles).toEqual(bundles);
        expect(job.finishedAt).toBeDefined();
    });

    it('carries the diagnostics a failure produced', async () => {
        const app = await buildApp(env, queue);
        const queued = await queueBuild(app);
        await toolchain.settle({ ok: false, diagnostics });

        const job = await readBuild(app, queued.jobId);
        expect(job.state).toBe('failed');
        expect(job.bundles).toBeUndefined();
        expect(job.diagnostics).toEqual(diagnostics);
    });

    it('reports a toolchain that died against the source it was handed', async () => {
        const app = await buildApp(env);
        const queued = await queueBuild(app);
        await drained();

        const job = await readBuild(app, queued.jobId);
        expect(job.state).toBe('failed');
        expect(job.diagnostics).toHaveLength(1);
        expect(job.diagnostics[0]?.file).toBe(SOURCE_HASH);
    });

    it('reports a job nothing queued as missing', async () => {
        const app = await buildApp(env, queue);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/builds/${UNKNOWN_JOB_ID}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('not_found');
    });
});

describe('cancelling', () => {
    let toolchain: ReturnType<typeof heldToolchain>;
    let queue: JobQueue;

    beforeEach(() => {
        toolchain = heldToolchain();
        queue = new InMemoryJobQueue(toolchain.compiler);
    });

    it('drops the record, so the job reads as one nothing queued', async () => {
        const app = await buildApp(env, queue);
        const queued = await queueBuild(app);

        const cancelled = await app.inject({
            method: 'DELETE',
            url: `/v1/builds/${queued.jobId}`,
            headers: bearer,
        });
        expect(cancelled.statusCode).toBe(204);
        expect(cancelled.body).toBe('');

        const response = await app.inject({
            method: 'GET',
            url: `/v1/builds/${queued.jobId}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
    });

    it('discards the outcome of a build cancelled while the toolchain held it', async () => {
        const app = await buildApp(env, queue);
        const queued = await queueBuild(app);
        await app.inject({ method: 'DELETE', url: `/v1/builds/${queued.jobId}`, headers: bearer });
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });

        const response = await app.inject({
            method: 'GET',
            url: `/v1/builds/${queued.jobId}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
    });

    it('is a conflict once the build finished', async () => {
        const app = await buildApp(env, queue);
        const queued = await queueBuild(app);
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });

        const response = await app.inject({
            method: 'DELETE',
            url: `/v1/builds/${queued.jobId}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
    });

    it('is a miss for a job nothing queued', async () => {
        const app = await buildApp(env, queue);
        const response = await app.inject({
            method: 'DELETE',
            url: `/v1/builds/${UNKNOWN_JOB_ID}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
    });
});

describe('the recent builds of one game', () => {
    const RecentBuilds = z.array(BuildJob);

    it('answers newest first, and only for the game asked about', async () => {
        const app = await buildApp(env, new InMemoryJobQueue(heldToolchain().compiler));
        const first = await queueBuild(app);
        const second = await queueBuild(app);
        await queueBuild(app, OTHER_GAME_ID);

        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/builds`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(200);
        const jobs = RecentBuilds.parse(response.json());
        expect(jobs.map((job) => job.jobId)).toEqual([second.jobId, first.jobId]);
    });

    it('honours a limit', async () => {
        const app = await buildApp(env, new InMemoryJobQueue(heldToolchain().compiler));
        await queueBuild(app);
        const second = await queueBuild(app);

        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/builds?limit=1`,
            headers: bearer,
        });
        const jobs = RecentBuilds.parse(response.json());
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.jobId).toBe(second.jobId);
    });

    it('refuses a limit that is not a count', async () => {
        const app = await buildApp(env);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/builds?limit=all`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(400);
    });
});

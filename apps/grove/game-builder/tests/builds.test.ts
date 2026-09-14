// The surface a creator's editor polls, and what the queue does to a job while it polls.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BuildJob, REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH } from '@grove/api-contract';
import type { BuildDiagnostic, BundleSet } from '@grove/api-contract';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { readEnv } from '../src/env.js';
import { InMemoryJobQueue } from '../src/pipeline.js';
import type { BuildOutcome, Compiler, JobQueue, QueueLimits } from '../src/pipeline.js';

const SECRET = 'e'.repeat(32);
const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const OTHER_GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const UNKNOWN_JOB_ID = '5b2f7cbe-6d1a-4f7d-9d4a-1b8d2c3e4f50';
const SOURCE_HASH = 'a3f1'.repeat(16);
const SERVER_HASH = 'b7c2'.repeat(16);
const CLIENT_HASH = 'c8d3'.repeat(16);
/** What `randomUUID` mints, which is what an unusable presented id has to be replaced by. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const env = readEnv({
    NODE_ENV: 'test',
    FLEET_SECRET: SECRET,
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

/** Waits out a deadline the test set, which only a real timer can pass. */
async function after(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await drained();
}

/** One line an operator would have seen, as the queue's logger was handed it. */
interface LogLine {
    level: 'info' | 'error';
    message: string;
    fields: Record<string, unknown>;
}

/** The levels the queue never reaches for. */
const ignore = (): void => {};

/** Fastify's logger cut down to what the queue calls, so a test can read the operator's side. */
function testLogger(): { logger: FastifyBaseLogger; lines: LogLine[] } {
    const lines: LogLine[] = [];
    const record =
        (level: LogLine['level']) =>
        (fields: unknown, message?: string): void => {
            const spoken = typeof fields === 'string' ? fields : (message ?? '');
            const bound = typeof fields === 'object' && fields !== null ? fields : {};
            lines.push({ level, message: spoken, fields: bound as Record<string, unknown> });
        };
    const logger: FastifyBaseLogger = {
        level: 'debug',
        fatal: record('error'),
        error: record('error'),
        warn: ignore,
        info: record('info'),
        debug: ignore,
        trace: ignore,
        silent: ignore,
        child: () => logger,
    };
    return { logger, lines };
}

/** A toolchain the test holds open, so a job's state is whatever the test has let happen so far. */
function heldToolchain(): {
    compiler: Compiler;
    signals: AbortSignal[];
    settle: (outcome: BuildOutcome) => Promise<void>;
} {
    const holding: ((outcome: BuildOutcome) => void)[] = [];
    const signals: AbortSignal[] = [];
    return {
        compiler: {
            compile: (_request, signal) => {
                signals.push(signal);
                return new Promise<BuildOutcome>((resolve) => holding.push(resolve));
            },
        },
        signals,
        settle: async (outcome) => {
            holding.shift()?.(outcome);
            await drained();
        },
    };
}

/** A toolchain that honours its abort, which is the only way a called-off compile rejects. */
function abortingToolchain(): { compiler: Compiler; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    return {
        compiler: {
            compile: (_request, signal) => {
                signals.push(signal);
                return new Promise<BuildOutcome>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        },
        signals,
    };
}

/** The queue as the app builds one, with a deadline no test waits out unless it asks for it. */
function testQueue(
    compiler: Compiler,
    limits: QueueLimits = { deadlineMs: 60_000 },
): { queue: InMemoryJobQueue; lines: LogLine[] } {
    const { logger, lines } = testLogger();
    return { queue: new InMemoryJobQueue(compiler, logger, limits), lines };
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
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
    });

    it('refuses a build with no bearer at all', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            payload: { gameId: GAME_ID, sourceHash: SOURCE_HASH },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('unauthorized');
    });

    it('refuses a bearer of the right length that is not the secret', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/builds/${UNKNOWN_JOB_ID}`,
            headers: { authorization: `Bearer ${'f'.repeat(SECRET.length)}` },
        });
        expect(response.statusCode).toBe(401);
    });
});

describe('the correlation id', () => {
    it('answers under the one @grove/api presented, which is how two logs join', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });

    it('replaces one too long for a log line rather than writing it down', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const presented = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);
        const response = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: presented },
        });
        expect(response.headers[REQUEST_ID_HEADER]).not.toBe(presented);
        expect(String(response.headers[REQUEST_ID_HEADER])).toMatch(MINTED);
    });

    it('mints one for a caller that presented none', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(String(response.headers[REQUEST_ID_HEADER])).toMatch(MINTED);
    });

    it('rides a refused bearer, which is the answer an operator is tracing', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            headers: { [REQUEST_ID_HEADER]: 'known-id' },
            payload: { gameId: GAME_ID, sourceHash: SOURCE_HASH },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });
});

describe('queueing a build', () => {
    it('answers 202 with the job in its queued state', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const job = await queueBuild(app);
        expect(job.state).toBe('queued');
        expect(job.gameId).toBe(GAME_ID);
        expect(job.diagnostics).toEqual([]);
        expect(job.startedAt).toBeUndefined();
        expect(job.bundles).toBeUndefined();
    });

    it('rejects a source hash the object store could never have named', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            headers: bearer,
            payload: { gameId: GAME_ID, sourceHash: 'the-latest-one' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('invalid_request');
    });

    it('rations one game without rationing the next', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        for (let build = 0; build < 10; build += 1) await queueBuild(app);

        const refused = await app.inject({
            method: 'POST',
            url: '/v1/builds',
            headers: bearer,
            payload: { gameId: GAME_ID, sourceHash: SOURCE_HASH },
        });
        expect(refused.statusCode).toBe(429);
        expect(refused.json().code).toBe('rate_limited');
        expect((await queueBuild(app, OTHER_GAME_ID)).state).toBe('queued');
    });
});

describe('a job under the toolchain', () => {
    let toolchain: ReturnType<typeof heldToolchain>;
    let queue: JobQueue;

    beforeEach(() => {
        toolchain = heldToolchain();
        queue = testQueue(toolchain.compiler).queue;
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

    it('reports a toolchain that died against the box, and tells the operator why', async () => {
        const died: Compiler = {
            compile: () => Promise.reject(new Error('ECONNREFUSED 10.0.7.3:4005')),
        };
        const { queue: faulting, lines } = testQueue(died);
        const app = await buildApp(env, faulting);
        const queued = await queueBuild(app);
        await drained();

        const job = await readBuild(app, queued.jobId);
        expect(job.state).toBe('failed');
        expect(job.diagnostics).toHaveLength(1);
        // A compile error is positioned in the creator's own source; a dead box never is.
        expect(job.diagnostics[0]?.file).toBe('build');
        expect(job.diagnostics[0]?.message).not.toContain('ECONNREFUSED');
        expect(lines).toContainEqual(
            expect.objectContaining({ level: 'error', message: 'toolchain failed' }),
        );
    });

    it('gives up on a compile that outlives its deadline, and starts the next', async () => {
        const app = await buildApp(env, testQueue(toolchain.compiler, { deadlineMs: 1 }).queue);
        const first = await queueBuild(app);
        const second = await queueBuild(app);
        await after(20);

        const job = await readBuild(app, first.jobId);
        expect(job.state).toBe('failed');
        expect(job.diagnostics[0]?.file).toBe('build');
        expect(toolchain.signals[0]?.aborted).toBe(true);
        expect((await readBuild(app, second.jobId)).startedAt).toBeDefined();
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
        queue = testQueue(toolchain.compiler).queue;
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

    it('aborts the compile it called off, and starts the build behind it', async () => {
        const app = await buildApp(env, queue);
        const first = await queueBuild(app);
        const second = await queueBuild(app);

        await app.inject({ method: 'DELETE', url: `/v1/builds/${first.jobId}`, headers: bearer });
        await drained();

        expect(toolchain.signals[0]?.aborted).toBe(true);
        expect((await readBuild(app, second.jobId)).state).toBe('running');
    });

    it('calls a build off without reporting the box as broken', async () => {
        const aborting = abortingToolchain();
        const { queue: honouring, lines } = testQueue(aborting.compiler);
        const app = await buildApp(env, honouring);
        const queued = await queueBuild(app);

        const off = await app.inject({
            method: 'DELETE',
            url: `/v1/builds/${queued.jobId}`,
            headers: bearer,
        });
        expect(off.statusCode).toBe(204);
        await drained();

        // The compile rejected because it was called off, which is the box working, not failing.
        expect(aborting.signals[0]?.aborted).toBe(true);
        expect(lines.filter((line) => line.level === 'error')).toEqual([]);
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

describe('what a box keeps', () => {
    it('forgets the oldest settled build once it holds more than it retains', async () => {
        const toolchain = heldToolchain();
        const limits: QueueLimits = { deadlineMs: 60_000, retain: 1 };
        const app = await buildApp(env, testQueue(toolchain.compiler, limits).queue);
        const first = await queueBuild(app);
        const second = await queueBuild(app);
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });

        const forgotten = await app.inject({
            method: 'GET',
            url: `/v1/builds/${first.jobId}`,
            headers: bearer,
        });
        expect(forgotten.statusCode).toBe(404);
        expect((await readBuild(app, second.jobId)).state).toBe('succeeded');
    });

    it('forgets a settled build that has outlived its retention', async () => {
        const toolchain = heldToolchain();
        const limits: QueueLimits = { deadlineMs: 60_000, retainMs: 10 };
        const app = await buildApp(env, testQueue(toolchain.compiler, limits).queue);
        const first = await queueBuild(app);
        const second = await queueBuild(app);
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });
        await after(20);
        await toolchain.settle({ ok: true, bundles, diagnostics: [] });

        const forgotten = await app.inject({
            method: 'GET',
            url: `/v1/builds/${first.jobId}`,
            headers: bearer,
        });
        expect(forgotten.statusCode).toBe(404);
        expect((await readBuild(app, second.jobId)).state).toBe('succeeded');
    });
});

describe('the recent builds of one game', () => {
    const RecentBuilds = z.array(BuildJob);

    it('answers newest first, and only for the game asked about', async () => {
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
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
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
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
        const app = await buildApp(env, testQueue(heldToolchain().compiler).queue);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/builds?limit=all`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(400);
    });
});

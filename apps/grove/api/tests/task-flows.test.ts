// A worker's claims and settles as application functions: an upload inspected out of quarantine,
// a build held to the outputs it stored, and the sweeper that finds what nobody was told about.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    objectKey,
    type VersionId,
    type BuildManifest,
    type GameId,
    type PlayableVersion,
    type PlayerId,
    type Task,
    type TaskId,
    type WorkspacePath,
} from '@grove/api-contract';
import type { Fleet } from '../src/fleet.js';
import type { Stores, Tasks } from '../src/records.js';
import { prismaStores } from '../src/store/index.js';
import { REAP_AFTER_LEASES, sweepOnce, sweepTasks } from '../src/sweeper.js';
import { ManifestCache, manifestFor, sourceFor, storeOutput } from '../src/workflows/build.js';
import { publish } from '../src/workflows/publishing.js';
import { advanceTask, type AdvanceDeps } from '../src/workflows/tasks.js';
import { requestUpload, saveWorkspace } from '../src/workflows/workspace.js';
import { announcing, bucket, recordingLog, type Bucket } from './doubles.js';
import { CDN, testEnv } from './fixtures.js';
import { database, type Database } from './pglite.js';

let harness: Database;
let stores: Stores;

beforeAll(async () => {
    harness = await database();
    stores = prismaStores(harness.db);
}, 60_000);

afterAll(async () => {
    await harness?.close();
});

beforeEach(async () => {
    await harness.reset();
});

const LEASE_MS = 60_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const ART = 'art/tile.png' as WorkspacePath;

let minted = 0;

async function owned(): Promise<{ owner: PlayerId; gameId: GameId }> {
    const created = await stores.accounts.createAccount(
        `creator-${String(minted++)}@grove.example`,
        'a long enough password',
        'Creator',
    );
    if (created.outcome !== 'created') throw new Error('the account was not created');
    const game = await stores.games.createGame(created.account.playerId, 'My Game');
    if (game.outcome !== 'created') throw new Error('the game was not created');
    return { owner: created.account.playerId, gameId: game.game.gameId };
}

interface Deploys {
    deployed: { gameId: GameId; revision: number }[];
}

function advancing(storage: Bucket, fleet: Partial<Fleet> = {}): AdvanceDeps & Deploys {
    const deployed: { gameId: GameId; revision: number }[] = [];
    return {
        tasks: stores.tasks,
        workspaces: stores.workspaces,
        storage,
        fleet: {
            deploy: async (gameId, version) => {
                deployed.push({ gameId, revision: version.revision });
            },
            ...fleet,
        },
        leases: { BUILD: LEASE_MS, ASSET_UPLOAD: LEASE_MS },
        log: recordingLog(),
        deployed,
    };
}

/** A game holding one uploaded asset, and the inspection its save queued. */
async function uploaded(
    storage: Bucket,
    body = PNG,
): Promise<{ gameId: GameId; owner: PlayerId; task: TaskId }> {
    const { owner, gameId } = await owned();
    const asked = await requestUpload(storage, 900, gameId, {
        path: ART,
        contentType: 'image/png',
        byteLength: body.byteLength,
    });
    if (asked.outcome !== 'signed') throw new Error(asked.outcome);
    storage.send(asked.upload.url, body, asked.upload.headers);
    const queue = announcing();
    const saved = await saveWorkspace(
        { workspaces: stores.workspaces, storage, queue, log: recordingLog() },
        gameId,
        owner,
        { baseRevision: 0, sources: [], assets: [ART], deletes: [] },
    );
    if (saved.outcome !== 'saved') throw new Error(saved.outcome);
    return { gameId, owner, task: queue.pushed[0]?.taskId as TaskId };
}

function claim(deps: AdvanceDeps, taskId: TaskId, kind: Task['kind'] = 'ASSET_UPLOAD') {
    return advanceTask(deps, {
        taskId,
        kind,
        worker: 'worker-1',
        update: { status: 'IN_PROGRESS' },
        requestId: 'req-1',
    });
}

function settle(
    deps: AdvanceDeps,
    taskId: TaskId,
    update: Parameters<typeof advanceTask>[1]['update'],
    kind: Task['kind'] = 'ASSET_UPLOAD',
) {
    return advanceTask(deps, { taskId, kind, worker: 'worker-1', update, requestId: 'req-1' });
}

/** What the asset service does with a claim: read quarantine, copy past it, name the copy. */
function inspectAndCopy(storage: Bucket, task: Task, body?: Buffer): VersionId {
    const work = task.inspection;
    if (work === undefined) throw new Error('the claim carried no inspection');
    const read = storage.send(work.source);
    expect(read.status).toBe(200);
    const copied = storage.send(work.destination, body ?? read.body, {
        'content-type': work.contentType,
    });
    if (copied.versionId === undefined)
        throw new Error(`the copy was refused: ${String(copied.status)}`);
    return copied.versionId;
}

describe('an asset upload', () => {
    it('is inspected out of quarantine, and verified by the copy it names', async () => {
        const storage = bucket();
        const { gameId, owner, task } = await uploaded(storage);
        const deps = advancing(storage);

        const claimed = await claim(deps, task);
        if (claimed.outcome !== 'advanced') throw new Error(claimed.outcome);
        expect(claimed.task.inspection).toMatchObject({
            contentType: 'image/png',
            byteLength: PNG.byteLength,
        });
        const copy = inspectAndCopy(storage, claimed.task);

        expect(
            await settle(deps, task, { status: 'SUCCESSFUL', detail: { versionId: copy } }),
        ).toMatchObject({
            outcome: 'advanced',
            task: { status: 'SUCCESSFUL' },
        });
        expect(await stores.workspaces.fileOf(gameId, ART)).toMatchObject({ edgeVersionId: copy });
        const published = await publish(
            { ...stores, queue: announcing(), log: recordingLog() },
            gameId,
            owner,
        );
        expect(published.outcome).toBe('queued');
    });

    it('fails rather than verifies a copy that is not the bytes it inspected', async () => {
        const storage = bucket();
        const { gameId, task } = await uploaded(storage);
        const deps = advancing(storage);
        const claimed = await claim(deps, task);
        if (claimed.outcome !== 'advanced') throw new Error(claimed.outcome);
        const short = inspectAndCopy(storage, claimed.task, PNG.subarray(0, 4));

        expect(
            await settle(deps, task, { status: 'SUCCESSFUL', detail: { versionId: short } }),
        ).toMatchObject({
            outcome: 'refused',
        });
        expect(await stores.tasks.taskOf(gameId, task)).toMatchObject({ status: 'FAILED' });
        expect(await stores.workspaces.fileOf(gameId, ART)).toMatchObject({
            edgeVersionId: undefined,
        });
    });

    it('is cancelled at its claim once a later save replaced the upload', async () => {
        const storage = bucket();
        const { gameId, owner, task } = await uploaded(storage);
        await harness.pg.query(`UPDATE "Task" SET "status" = 'NOT_STARTED'`);
        // A second save naming a new upload of the same path, which cancels the first inspection.
        const asked = await requestUpload(storage, 900, gameId, {
            path: ART,
            contentType: 'image/png',
            byteLength: 3,
        });
        if (asked.outcome !== 'signed') throw new Error(asked.outcome);
        storage.send(asked.upload.url, Buffer.from('abc'), asked.upload.headers);
        await saveWorkspace(
            { workspaces: stores.workspaces, storage, queue: announcing(), log: recordingLog() },
            gameId,
            owner,
            { baseRevision: 1, sources: [], assets: [ART], deletes: [] },
        );

        expect(await claim(advancing(storage), task)).toMatchObject({ outcome: 'refused' });
        expect(await stores.tasks.taskOf(gameId, task)).toMatchObject({ status: 'CANCELLED' });
    });

    it('discards the copy a superseded worker made, and keeps the one a repeated settle names', async () => {
        const storage = bucket();
        const { gameId, task } = await uploaded(storage);
        const deps = advancing(storage);
        const claimed = await claim(deps, task);
        if (claimed.outcome !== 'advanced') throw new Error(claimed.outcome);
        const copy = inspectAndCopy(storage, claimed.task);
        await settle(deps, task, { status: 'SUCCESSFUL', detail: { versionId: copy } });

        // The worker's answer was lost, so it settles the same success again.
        expect(
            await settle(deps, task, { status: 'SUCCESSFUL', detail: { versionId: copy } }),
        ).toMatchObject({
            outcome: 'refused',
        });
        const key = objectKey(gameId, 'asset', ART);
        expect(storage.current(key)?.versionId).toBe(copy);

        // A copy nobody's row names is taken back by version, so the verified one is current again.
        const stray = await storage.put(key, Buffer.from('stray'), 'image/png');
        if (stray.outcome !== 'written') throw new Error(stray.outcome);
        await settle(deps, task, {
            status: 'SUCCESSFUL',
            detail: { versionId: stray.version.versionId },
        });
        expect(storage.current(key)?.versionId).toBe(copy);
    });

    it('refuses a second claim while the first is held, and counts no attempt for it', async () => {
        const storage = bucket();
        const { gameId, task } = await uploaded(storage);
        const deps = advancing(storage);
        await claim(deps, task);
        expect(await claim(deps, task)).toEqual({
            outcome: 'refused',
            message: 'the task is already claimed',
        });
        expect(await stores.tasks.taskOf(gameId, task)).toMatchObject({ attempts: 1 });
    });

    it('is invalid as a success that names no copy', async () => {
        const storage = bucket();
        const { task } = await uploaded(storage);
        const deps = advancing(storage);
        await claim(deps, task);
        expect(await settle(deps, task, { status: 'SUCCESSFUL' })).toMatchObject({
            outcome: 'invalid',
        });
    });
});

const HASH = 'a'.repeat(64);

describe('a build', () => {
    async function claimedBuild(storage: Bucket, revision = 1) {
        const { owner, gameId } = await owned();
        const saveId = crypto.randomUUID();
        await harness.pg.query(
            `UPDATE "Game" SET "draftRevision" = $1, "draftSaveId" = $2 WHERE "id" = $3`,
            [revision, saveId, gameId],
        );
        await storage.put(
            `${gameId}/manifests/${String(revision)}-${saveId}.json`,
            Buffer.from(
                JSON.stringify({
                    gameId,
                    revision,
                    files: [
                        {
                            path: 'main.ts',
                            kind: 'source',
                            versionId: 'v-main',
                            byteLength: 2,
                            contentType: 'text/typescript',
                        },
                    ],
                }),
            ),
            'application/json',
        );
        const queued = await stores.tasks.queueBuild(gameId, owner, revision, saveId);
        if (queued.outcome !== 'queued') throw new Error(queued.outcome);
        const deps = advancing(storage);
        await claim(deps, queued.task.taskId, 'BUILD');
        return { gameId, owner, taskId: queued.task.taskId, deps };
    }

    const buildDeps = (storage: Bucket) => ({
        tasks: stores.tasks,
        storage,
        manifests: new ManifestCache(),
        cdnUrl: CDN,
    });

    async function produced(
        storage: Bucket,
        gameId: GameId,
        taskId: TaskId,
        revision = 1,
    ): Promise<BuildManifest> {
        const deps = buildDeps(storage);
        const stored = async (name: string, body: string) => {
            const output = await storeOutput(deps, taskId, name, Buffer.from(body));
            if (output.outcome !== 'stored') throw new Error(output.outcome);
            return output.artifact;
        };
        const client = await stored('client.js', 'export const side = "client";');
        const simConfig = await stored('simConfig.json', '{"simRate":30}');
        const server = await stored('server-0123456789abcdef.js', 'var server;');
        return {
            gameId,
            revision,
            projectId: 'leaf-harvest',
            projectHash: HASH,
            bundles: {
                client: {
                    side: 'client',
                    hash: client.hash,
                    url: client.url,
                    byteLength: client.byteLength,
                },
                server: {
                    side: 'server',
                    hash: server.hash,
                    url: server.url,
                    byteLength: server.byteLength,
                },
                simConfig: {
                    hash: simConfig.hash,
                    url: simConfig.url,
                    byteLength: simConfig.byteLength,
                },
                syncedHash: HASH,
            },
        };
    }

    it('stores each output under its own digest beneath the task, and the edge may cache it forever', async () => {
        const storage = bucket();
        const { gameId, taskId } = await claimedBuild(storage);
        const deps = buildDeps(storage);
        const first = await storeOutput(deps, taskId, 'client.js', Buffer.from('one'));
        const second = await storeOutput(deps, taskId, 'client.js', Buffer.from('two'));
        if (first.outcome !== 'stored' || second.outcome !== 'stored')
            throw new Error('not stored');

        expect(first.artifact.url).toBe(
            `${CDN}/${gameId}/build/${taskId}/${first.artifact.hash}/client.js`,
        );
        expect(second.artifact.url).not.toBe(first.artifact.url);
        const key = first.artifact.url.slice(CDN.length + 1);
        expect(storage.current(key)?.cacheControl).toBe('public, max-age=31536000, immutable');
        expect(storage.current(key)?.contentType).toBe('text/javascript');
    });

    it('is accepted when it names exactly what it stored, and the fleet is told of it', async () => {
        const storage = bucket();
        const { gameId, taskId, deps } = await claimedBuild(storage);
        const build = await produced(storage, gameId, taskId);

        const settled = await settle(
            deps,
            taskId,
            { status: 'SUCCESSFUL', detail: { build } },
            'BUILD',
        );
        if (settled.outcome !== 'advanced') throw new Error(settled.outcome);
        await settled.deployment;
        expect(deps.deployed).toEqual([{ gameId, revision: 1 }]);
        expect(await stores.tasks.playableVersionOf(gameId)).toMatchObject({ revision: 1 });
    });

    it('is failed when it names an output it never stored', async () => {
        const storage = bucket();
        const { gameId, taskId, deps } = await claimedBuild(storage);
        const build = await produced(storage, gameId, taskId);
        const forged = {
            ...build,
            bundles: {
                ...build.bundles,
                server: { ...build.bundles.server, url: 'https://evil.example/x.js' },
            },
        };

        expect(
            await settle(
                deps,
                taskId,
                { status: 'SUCCESSFUL', detail: { build: forged } },
                'BUILD',
            ),
        ).toMatchObject({
            outcome: 'refused',
        });
        expect(await stores.tasks.taskOf(gameId, taskId)).toMatchObject({ status: 'FAILED' });
        expect(deps.deployed).toEqual([]);
    });

    it('tells the fleet nothing for a version older than the one already playable', async () => {
        const storage = bucket();
        const { gameId, taskId, deps } = await claimedBuild(storage, 1);
        const build = await produced(storage, gameId, taskId, 1);
        const newer: PlayableVersion = {
            revision: 5,
            projectId: 'p',
            projectHash: HASH,
            bundles: build.bundles,
        };
        const ahead: Tasks = { ...stores.tasks, playableVersionOf: async () => newer };

        const settled = await settle(
            { ...deps, tasks: ahead },
            taskId,
            { status: 'SUCCESSFUL', detail: { build } },
            'BUILD',
        );
        if (settled.outcome !== 'advanced') throw new Error(settled.outcome);
        await settled.deployment;
        expect(deps.deployed).toEqual([]);
    });

    it('settles all the same when the fleet would not take the deployment', async () => {
        const storage = bucket();
        const { gameId, taskId } = await claimedBuild(storage);
        const build = await produced(storage, gameId, taskId);
        const failing = advancing(storage, {
            deploy: async () => {
                throw new Error('server-manager answered 503');
            },
        });
        const settled = await settle(
            failing,
            taskId,
            { status: 'SUCCESSFUL', detail: { build } },
            'BUILD',
        );
        if (settled.outcome !== 'advanced') throw new Error(settled.outcome);
        await expect(settled.deployment).resolves.toBeUndefined();
    });

    it('reads its manifest once however many sources it fetches', async () => {
        const storage = bucket();
        const { gameId, taskId } = await claimedBuild(storage);
        await storage.put(
            objectKey(gameId, 'source', 'main.ts' as WorkspacePath),
            Buffer.from('a'),
            'text/typescript',
        );
        const reads: string[] = [];
        const counting: Bucket = {
            ...storage,
            get: async (key, versionId) => {
                reads.push(key);
                return storage.get(key, versionId);
            },
        };
        const deps = buildDeps(counting);
        for (let fetch = 0; fetch < 5; fetch += 1)
            await sourceFor(deps, taskId, 'main.ts' as WorkspacePath);
        expect(reads.filter((key) => key.includes('/manifests/'))).toHaveLength(1);
    });

    it('hands its source to nobody once it is no longer claimed', async () => {
        const storage = bucket();
        const { taskId, deps } = await claimedBuild(storage);
        await settle(deps, taskId, { status: 'FAILED' }, 'BUILD');
        expect(await manifestFor(buildDeps(storage), taskId)).toEqual({ outcome: 'unclaimed' });
        expect(
            await storeOutput(buildDeps(storage), taskId, 'client.js', Buffer.from('x')),
        ).toEqual({
            outcome: 'unclaimed',
        });
    });
});

describe('the sweeper', () => {
    const env = testEnv({ TASK_SWEEP_AFTER_MS: '60000', BUILD_LEASE_MS: String(LEASE_MS) });

    async function queuedBuild() {
        const { owner, gameId } = await owned();
        await harness.pg.query(`UPDATE "Game" SET "draftRevision" = 1 WHERE "id" = $1`, [gameId]);
        const queued = await stores.tasks.queueBuild(gameId, owner, 1, undefined);
        if (queued.outcome !== 'queued') throw new Error(queued.outcome);
        return { gameId, taskId: queued.task.taskId };
    }

    it('re-announces what nobody was told about lately, once per window rather than every pass', async () => {
        const { taskId } = await queuedBuild();
        const queue = announcing();
        const now = Date.now();

        expect((await sweepOnce(stores.tasks, queue, env, recordingLog(), now)).announced).toEqual(
            [],
        );
        const later = now + 61_000;
        expect(
            (await sweepOnce(stores.tasks, queue, env, recordingLog(), later)).announced,
        ).toEqual([taskId]);
        expect(
            (await sweepOnce(stores.tasks, queue, env, recordingLog(), later + 1_000)).announced,
        ).toEqual([]);
        expect(queue.pushed).toEqual([{ kind: 'BUILD', taskId }]);
    });

    it('leaves a push that failed due, so the next pass makes it again', async () => {
        const { taskId } = await queuedBuild();
        const later = Date.now() + 61_000;
        const down = {
            push: async () => ({ outcome: 'unavailable' as const }),
            close: async () => undefined,
        };
        await sweepOnce(stores.tasks, down, env, recordingLog(), later);
        expect(
            (await sweepOnce(stores.tasks, announcing(), env, recordingLog(), later)).announced,
        ).toEqual([taskId]);
    });

    it('re-announces a claim whose lease ran out, which a trimmed stream entry leaves stranded', async () => {
        const { taskId } = await queuedBuild();
        await stores.tasks.claimTask(taskId, { kind: 'BUILD', worker: 'w', leaseMs: LEASE_MS });
        const lapsed = Date.now() + LEASE_MS + 61_000;
        expect(
            (await sweepOnce(stores.tasks, announcing(), env, recordingLog(), lapsed)).announced,
        ).toEqual([taskId]);
    });

    it(`fails a claim nobody came back to for ${String(REAP_AFTER_LEASES)} lease windows`, async () => {
        const { gameId, taskId } = await queuedBuild();
        await stores.tasks.claimTask(taskId, { kind: 'BUILD', worker: 'w', leaseMs: LEASE_MS });
        const soon = Date.now() + LEASE_MS * (REAP_AFTER_LEASES - 1) - 1_000;
        expect(
            (await sweepOnce(stores.tasks, announcing(), env, recordingLog(), soon)).reaped,
        ).toEqual([]);
        const abandoned = Date.now() + LEASE_MS * REAP_AFTER_LEASES + 1_000;
        expect(
            (await sweepOnce(stores.tasks, announcing(), env, recordingLog(), abandoned)).reaped,
        ).toEqual([taskId]);
        expect(await stores.tasks.taskOf(gameId, taskId)).toMatchObject({ status: 'FAILED' });
    });

    describe('on its interval', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('passes every interval until stopped, and survives a pass that throws', async () => {
            let passes = 0;
            const tasks: Tasks = {
                ...stores.tasks,
                dueForAnnouncement: async () => {
                    passes += 1;
                    if (passes === 1) throw new Error('the database blinked');
                    return [];
                },
                markAnnounced: async () => undefined,
                reapAbandoned: async () => [],
            };
            const log = recordingLog();
            const sweeper = sweepTasks(tasks, announcing(), env, log);
            await vi.advanceTimersByTimeAsync(env.TASK_SWEEP_INTERVAL_MS * 3);
            sweeper.stop();
            await vi.advanceTimersByTimeAsync(env.TASK_SWEEP_INTERVAL_MS * 3);

            expect(passes).toBeGreaterThanOrEqual(3);
            expect(passes).toBeLessThanOrEqual(6);
            expect(log.lines.some((line) => line.message === 'task sweep failed')).toBe(true);
        });
    });
});

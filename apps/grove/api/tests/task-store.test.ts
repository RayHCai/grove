// The task table against a real Postgres: what a publish may queue, what a claim holds and for
// how long, what a settle writes, and what the sweeper is handed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    VersionId,
    type BuildManifest,
    type BundleSet,
    type GameId,
    type PlayerId,
    type TaskId,
    type WorkspacePath,
} from '@grove/api-contract';
import type { Stores } from '../src/records.js';
import { prismaStores } from '../src/store/index.js';
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

let minted = 0;

/** A game whose last save reached `revision`, which is the only revision a build may pin. */
async function owned(revision = 4): Promise<{ owner: PlayerId; gameId: GameId; saveId: string }> {
    const created = await stores.accounts.createAccount(
        `creator-${String(minted++)}@grove.example`,
        'a long enough password',
        'Creator',
    );
    if (created.outcome !== 'created') throw new Error('the account was not created');
    const game = await stores.games.createGame(created.account.playerId, 'My Game');
    if (game.outcome !== 'created') throw new Error('the game was not created');
    const saveId = crypto.randomUUID();
    await harness.pg.query(
        `UPDATE "Game" SET "draftRevision" = $1, "draftSaveId" = $2 WHERE "id" = $3`,
        [revision, saveId, game.game.gameId],
    );
    return { owner: created.account.playerId, gameId: game.game.gameId, saveId };
}

async function queued(revision = 4) {
    const game = await owned(revision);
    const outcome = await stores.tasks.queueBuild(game.gameId, game.owner, revision, game.saveId);
    if (outcome.outcome !== 'queued') throw new Error(`expected queued, got ${outcome.outcome}`);
    return { ...game, taskId: outcome.task.taskId };
}

const BUILD = { kind: 'BUILD' as const, worker: 'box-1', leaseMs: 60_000 };

/** Moves a claim's lease into the past, which is what a worker that died leaves behind. */
async function lapse(taskId: TaskId, ago = '1 second'): Promise<void> {
    await harness.pg.query(
        `UPDATE "Task" SET "leaseUntil" = now() - $1::interval WHERE "id" = $2`,
        [ago, taskId],
    );
}

describe('queueing a build', () => {
    it('pins the revision the last save froze, and the save that froze it', async () => {
        const { gameId, taskId, saveId } = await queued(4);
        expect(await stores.tasks.taskOf(gameId, taskId)).toMatchObject({
            kind: 'BUILD',
            status: 'NOT_STARTED',
            manifestRevision: 4,
            attempts: 0,
        });
        expect(await stores.tasks.buildOf(taskId)).toMatchObject({
            revision: 4,
            saveId,
            live: false,
        });
    });

    it('hands back the build already in flight rather than a second one of the same revision', async () => {
        const { owner, gameId, saveId, taskId } = await queued(4);
        expect(await stores.tasks.queueBuild(gameId, owner, 4, saveId)).toMatchObject({
            outcome: 'existing',
            task: { taskId },
        });
        await stores.tasks.claimTask(taskId, BUILD);
        expect(await stores.tasks.queueBuild(gameId, owner, 4, saveId)).toMatchObject({
            outcome: 'existing',
            task: { taskId },
        });
    });

    it('queues another once the one before settled, which is what a rebuild is', async () => {
        const { owner, gameId, saveId, taskId } = await queued(4);
        await stores.tasks.settleTask(taskId, 'BUILD', { status: 'FAILED' });
        const again = await stores.tasks.queueBuild(gameId, owner, 4, saveId);
        expect(again.outcome).toBe('queued');
    });

    it('refuses a revision the workspace has moved past, or a save that did not freeze it', async () => {
        const { owner, gameId, saveId } = await owned(4);
        expect((await stores.tasks.queueBuild(gameId, owner, 3, saveId)).outcome).toBe('moved');
        expect((await stores.tasks.queueBuild(gameId, owner, 4, crypto.randomUUID())).outcome).toBe(
            'moved',
        );
    });

    it('refuses while an asset of that revision is unverified, and names it', async () => {
        const { owner, gameId, saveId } = await owned(4);
        await harness.pg.query(
            `INSERT INTO "GameFile" ("gameId", "path", "kind", "versionId", "byteLength",
                "contentType", "updatedAt")
             VALUES ($1, 'art/tile.png', 'asset', 'u1', 10, 'image/png', now())`,
            [gameId],
        );
        expect(await stores.tasks.queueBuild(gameId, owner, 4, saveId)).toEqual({
            outcome: 'unverified',
            paths: ['art/tile.png'],
        });

        await harness.pg.query(
            `UPDATE "GameFile" SET "validatedVersionId" = 'u1', "edgeVersionId" = 'c1'`,
        );
        expect((await stores.tasks.queueBuild(gameId, owner, 4, saveId)).outcome).toBe('queued');
    });

    it('says the game is missing rather than queueing work nothing can settle', async () => {
        const { owner } = await owned(4);
        const absent = '00000000-0000-4000-8000-000000000000' as GameId;
        expect(await stores.tasks.queueBuild(absent, owner, 1, undefined)).toEqual({
            outcome: 'missing',
        });
    });
});

describe('a claim', () => {
    it('counts an attempt, dates the start, and holds a lease', async () => {
        const { taskId } = await queued();
        const claimed = await stores.tasks.claimTask(taskId, BUILD);
        expect(claimed).toMatchObject({
            outcome: 'claimed',
            task: { status: 'IN_PROGRESS', attempts: 1 },
        });
        const row = await harness.pg.query<{ claimedBy: string; leaseUntil: Date }>(
            `SELECT "claimedBy", "leaseUntil" FROM "Task" WHERE "id" = $1`,
            [taskId],
        );
        expect(row.rows[0]?.claimedBy).toBe('box-1');
        expect(row.rows[0]?.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    });

    // Four deliveries of one message used to be four attempts and a healthy build settled failed.
    it('refuses a second claim while the lease is live, without counting an attempt', async () => {
        const { gameId, taskId } = await queued();
        await stores.tasks.claimTask(taskId, BUILD);
        for (let duplicate = 0; duplicate < 4; duplicate += 1) {
            expect(
                (await stores.tasks.claimTask(taskId, { ...BUILD, worker: 'box-2' })).outcome,
            ).toBe('held');
        }
        expect(await stores.tasks.taskOf(gameId, taskId)).toMatchObject({ attempts: 1 });
    });

    it('is taken back once the lease runs out, and that one counts', async () => {
        const { taskId } = await queued();
        await stores.tasks.claimTask(taskId, BUILD);
        await lapse(taskId);
        expect(await stores.tasks.claimTask(taskId, { ...BUILD, worker: 'box-2' })).toMatchObject({
            outcome: 'claimed',
            task: { attempts: 2 },
        });
    });

    it('is refused for a settled task, and for a task of the other kind', async () => {
        const { taskId } = await queued();
        expect(
            (await stores.tasks.claimTask(taskId, { ...BUILD, kind: 'ASSET_UPLOAD' })).outcome,
        ).toBe('missing');
        await stores.tasks.settleTask(taskId, 'BUILD', { status: 'CANCELLED' });
        expect((await stores.tasks.claimTask(taskId, BUILD)).outcome).toBe('settled');
    });

    it('refuses a claim in flight with no end, which nobody could take back', async () => {
        const { taskId } = await queued();
        await expect(
            harness.pg.query(
                `UPDATE "Task" SET "status" = 'IN_PROGRESS', "startedAt" = now(), "leaseUntil" = NULL
                  WHERE "id" = $1`,
                [taskId],
            ),
        ).rejects.toThrow();
    });
});

describe('a settle', () => {
    it('is written once, and a redelivered one cannot walk it back', async () => {
        const { taskId } = await queued();
        await stores.tasks.claimTask(taskId, BUILD);
        expect(
            await stores.tasks.settleTask(taskId, 'BUILD', {
                status: 'FAILED',
                detail: { message: 'it did not compile' },
            }),
        ).toMatchObject({ outcome: 'settled', task: { status: 'FAILED' } });
        expect(
            await stores.tasks.settleTask(taskId, 'BUILD', { status: 'SUCCESSFUL' }),
        ).toMatchObject({ outcome: 'refused', task: { status: 'FAILED' } });
    });

    it('dates the start of a task settled without ever being claimed', async () => {
        const { taskId } = await queued();
        const settled = await stores.tasks.settleTask(taskId, 'BUILD', { status: 'CANCELLED' });
        expect(settled.outcome === 'settled' && settled.task.startedAt).toBeTruthy();
    });

    it('never finishes before it started, whatever clock dated the start', async () => {
        const { taskId } = await queued();
        await stores.tasks.claimTask(taskId, BUILD);
        await harness.pg.query(
            `UPDATE "Task" SET "startedAt" = now() + interval '5 seconds' WHERE "id" = $1`,
            [taskId],
        );
        expect((await stores.tasks.settleTask(taskId, 'BUILD', { status: 'FAILED' })).outcome).toBe(
            'settled',
        );
    });
});

describe('what a build stored', () => {
    const artifact = {
        name: 'client.js',
        url: 'https://cdn.grove.example/g/build/t/aa/client.js',
        hash: 'a'.repeat(64),
        byteLength: 10,
    };

    it('is recorded once however often it is stored, and goes with the task', async () => {
        const { gameId, taskId } = await queued();
        await stores.tasks.recordArtifact(taskId, artifact);
        await stores.tasks.recordArtifact(taskId, artifact);
        expect(await stores.tasks.artifactsOf(taskId)).toEqual([artifact]);

        await harness.pg.exec(`DELETE FROM "Game" WHERE "id" = '${gameId}'`);
        expect(await stores.tasks.artifactsOf(taskId)).toEqual([]);
    });
});

const HASH = 'a'.repeat(64);

function bundles(hash = HASH): BundleSet {
    return {
        server: { side: 'server', hash, url: `https://cdn.grove.example/b/${hash}`, byteLength: 1 },
        client: { side: 'client', hash, url: `https://cdn.grove.example/b/${hash}`, byteLength: 1 },
        simConfig: { hash, url: `https://cdn.grove.example/b/${hash}.json`, byteLength: 1 },
        syncedHash: hash,
    };
}

describe('the playable version', () => {
    function built(gameId: GameId, revision: number, hash = HASH): BuildManifest {
        return {
            gameId,
            revision,
            projectId: 'my-game',
            projectHash: hash,
            bundles: bundles(hash),
        };
    }

    async function build(
        gameId: GameId,
        owner: PlayerId,
        revision: number,
        manifest?: BuildManifest,
    ) {
        const saveId = crypto.randomUUID();
        await harness.pg.query(
            `UPDATE "Game" SET "draftRevision" = $1, "draftSaveId" = $2 WHERE "id" = $3`,
            [revision, saveId, gameId],
        );
        const queuedBuild = await stores.tasks.queueBuild(gameId, owner, revision, saveId);
        if (queuedBuild.outcome !== 'queued') throw new Error(queuedBuild.outcome);
        await stores.tasks.claimTask(queuedBuild.task.taskId, BUILD);
        await stores.tasks.settleTask(
            queuedBuild.task.taskId,
            'BUILD',
            manifest === undefined
                ? { status: 'FAILED' }
                : { status: 'SUCCESSFUL', detail: { build: manifest } },
        );
        return queuedBuild.task.taskId;
    }

    it('is the highest revision that finished, never one that failed after it', async () => {
        const { owner, gameId } = await owned(1);
        await build(gameId, owner, 1, built(gameId, 1));
        await build(gameId, owner, 2);
        expect(await stores.tasks.playableVersionOf(gameId)).toMatchObject({ revision: 1 });
    });

    it('is the latest finish of one revision rebuilt, which no longer ties', async () => {
        const { owner, gameId } = await owned(1);
        const first = await build(gameId, owner, 3, built(gameId, 3, 'b'.repeat(64)));
        const second = await build(gameId, owner, 3, built(gameId, 3, 'c'.repeat(64)));
        await harness.pg.query(
            `UPDATE "Task"
                SET "startedAt" = "startedAt" - interval '1 hour',
                    "finishedAt" = "finishedAt" - interval '1 hour'
              WHERE "id" = $1`,
            [first],
        );
        expect(second).not.toBe(first);
        expect(await stores.tasks.playableVersionOf(gameId)).toMatchObject({
            projectHash: 'c'.repeat(64),
        });
    });

    it('is nothing for a build naming another revision than the task it settled', async () => {
        const { owner, gameId } = await owned(1);
        await build(gameId, owner, 3, built(gameId, 9));
        expect(await stores.tasks.playableVersionOf(gameId)).toBeUndefined();
    });
});

describe('what the sweeper is handed', () => {
    it('is unclaimed work announced before the cutoff, and nothing announced since', async () => {
        const { taskId } = await queued();
        const now = new Date();
        const minuteAgo = new Date(now.getTime() - 60_000);
        expect(await stores.tasks.dueForAnnouncement('BUILD', minuteAgo, now, 10)).toEqual([]);

        const ahead = new Date(Date.now() + 60_000);
        expect(await stores.tasks.dueForAnnouncement('BUILD', ahead, ahead, 10)).toEqual([taskId]);
        expect(await stores.tasks.dueForAnnouncement('ASSET_UPLOAD', ahead, ahead, 10)).toEqual([]);

        await stores.tasks.markAnnounced([taskId], ahead);
        expect(await stores.tasks.dueForAnnouncement('BUILD', ahead, ahead, 10)).toEqual([]);
    });

    it('is a claim whose lease ran out, and never one still held', async () => {
        const { taskId } = await queued();
        await stores.tasks.claimTask(taskId, BUILD);
        const ahead = new Date(Date.now() + 1_000);
        expect(await stores.tasks.dueForAnnouncement('BUILD', ahead, new Date(), 10)).toEqual([]);
        await lapse(taskId);
        expect(await stores.tasks.dueForAnnouncement('BUILD', ahead, new Date(), 10)).toEqual([
            taskId,
        ]);
    });

    it('fails a claim abandoned past the cutoff, and nothing claimed since', async () => {
        const stale = await queued(4);
        const fresh = await queued(5);
        await stores.tasks.claimTask(stale.taskId, BUILD);
        await stores.tasks.claimTask(fresh.taskId, BUILD);
        await lapse(stale.taskId, '10 minutes');

        const before = new Date(Date.now() - 5 * 60_000);
        expect(await stores.tasks.reapAbandoned('ASSET_UPLOAD', before, 'abandoned')).toEqual([]);
        expect(await stores.tasks.reapAbandoned('BUILD', before, 'abandoned')).toEqual([
            stale.taskId,
        ]);
        expect(await stores.tasks.taskOf(stale.gameId, stale.taskId)).toMatchObject({
            status: 'FAILED',
            detail: { message: 'abandoned' },
        });
        expect(await stores.tasks.taskOf(fresh.gameId, fresh.taskId)).toMatchObject({
            status: 'IN_PROGRESS',
        });
    });
});

describe('an upload task', () => {
    it('names the upload the game holds, and nothing once a save replaced it', async () => {
        const { owner, gameId } = await owned(0);
        const art = {
            path: 'art/tile.png' as WorkspacePath,
            kind: 'asset' as const,
            versionId: VersionId.parse('u1'),
            byteLength: 10,
            contentType: 'image/png',
        };
        const first = await stores.workspaces.saveWorkspace(gameId, {
            baseRevision: 0,
            saveId: crypto.randomUUID(),
            accountId: owner,
            upserts: [art],
            deletes: [],
            frozen: [art],
        });
        if (first.outcome !== 'saved') throw new Error(first.outcome);
        const task = first.tasks[0]?.taskId as TaskId;
        expect(await stores.tasks.uploadOf(task)).toMatchObject({
            versionId: 'u1',
            byteLength: 10,
        });

        const second = { ...art, versionId: VersionId.parse('u2') };
        await stores.workspaces.saveWorkspace(gameId, {
            baseRevision: 1,
            saveId: crypto.randomUUID(),
            accountId: owner,
            upserts: [second],
            deletes: [],
            frozen: [second],
        });
        expect(await stores.tasks.uploadOf(task)).toBeUndefined();
    });
});

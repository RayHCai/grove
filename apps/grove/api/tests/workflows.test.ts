// The save, the publish, the delete and the join as application functions over a real Postgres and
// a bucket that refuses what S3 would, with no HTTP in between.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    manifestKey,
    objectKey,
    uploadKey,
    type GameId,
    type PlayerId,
    type WorkspacePath,
} from '@grove/api-contract';
import { ticketSigningKey, verifyTicket } from '@grove/api-contract/tokens';
import type { Stores, Workspaces } from '../src/records.js';
import { prismaStores } from '../src/store/index.js';
import { deleteGame } from '../src/workflows/games.js';
import { play } from '../src/workflows/play.js';
import { publish } from '../src/workflows/publishing.js';
import {
    readFile,
    requestUpload,
    saveWorkspace,
    type SaveDeps,
} from '../src/workflows/workspace.js';
import { announcing, bucket, recordingLog, type Bucket } from './doubles.js';
import { SESSION_ID, TICKET_KEY, TICKET_SEED } from './fixtures.js';
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

const SOURCE = 'export const pip = 1;\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function deps(
    storage: Bucket,
    workspaces: Workspaces = stores.workspaces,
): SaveDeps & {
    queue: ReturnType<typeof announcing>;
} {
    return { workspaces, storage, queue: announcing(), log: recordingLog() };
}

/** What a browser does with the answer to an upload request: one PUT, carrying what it was told. */
async function upload(storage: Bucket, gameId: GameId, path: string, body: Buffer): Promise<void> {
    const asked = await requestUpload(storage, 900, gameId, {
        path: path as WorkspacePath,
        contentType: 'image/png',
        byteLength: body.byteLength,
    });
    if (asked.outcome !== 'signed') throw new Error(asked.outcome);
    expect(storage.send(asked.upload.url, body, asked.upload.headers).status).toBe(200);
}

describe('a save', () => {
    it('stores every byte, the manifest included, before the transaction and never during it', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        const timeline: string[] = [];
        const watched: Workspaces = {
            ...stores.workspaces,
            saveWorkspace: async (game, plan) => {
                timeline.push('transaction begins');
                const saved = await stores.workspaces.saveWorkspace(game, plan);
                timeline.push('transaction ends');
                return saved;
            },
        };
        const recording: Bucket = {
            ...storage,
            put: async (key, body, type, options) => {
                timeline.push(`put ${key}`);
                return storage.put(key, body, type, options);
            },
        };

        const saved = await saveWorkspace(deps(recording, watched), gameId, owner, {
            baseRevision: 0,
            sources: [
                { path: 'main.ts' as WorkspacePath, contentType: 'text/typescript', text: SOURCE },
            ],
            assets: [],
            deletes: [],
        });
        if (saved.outcome !== 'saved') throw new Error(saved.outcome);

        const key = manifestKey(gameId, 1, saved.workspace.saveId);
        expect(timeline).toEqual([
            `put ${objectKey(gameId, 'source', 'main.ts' as WorkspacePath)}`,
            `put ${key}`,
            'transaction begins',
            'transaction ends',
        ]);
        // The manifest at that key is the set the rows came to name.
        const frozen = JSON.parse((await storage.get(key))?.body.toString('utf8') ?? '{}');
        expect(frozen).toMatchObject({ revision: 1, files: saved.workspace.files });
    });

    it('takes back every version it wrote when it loses the race, so the winner is current again', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        const main = { path: 'main.ts' as WorkspacePath, contentType: 'text/typescript' };
        const winner = await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 0,
            sources: [{ ...main, text: 'the winner' }],
            assets: [],
            deletes: [],
        });
        if (winner.outcome !== 'saved') throw new Error(winner.outcome);

        // The loser read the workspace before the winner landed, so it got as far as the claim.
        const before = { ...winner.workspace, revision: 0, saveId: undefined, files: [] };
        const late: Workspaces = { ...stores.workspaces, workspaceOf: async () => before };
        const loser = await saveWorkspace(deps(storage, late), gameId, owner, {
            baseRevision: 0,
            sources: [{ ...main, text: 'the loser' }],
            assets: [],
            deletes: [],
        });
        expect(loser).toEqual({ outcome: 'stale', revision: 1 });

        const key = objectKey(gameId, 'source', main.path);
        expect(storage.current(key)?.body.toString('utf8')).toBe('the winner');
        expect([...storage.versions.keys()].filter((held) => held.includes('/manifests/'))).toEqual(
            [manifestKey(gameId, 1, winner.workspace.saveId)],
        );
    });

    it('refuses a save already stale before writing a byte', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 0,
            sources: [{ path: 'a.ts' as WorkspacePath, contentType: 'text/typescript', text: '' }],
            assets: [],
            deletes: [],
        });
        const written = storage.versions.size;
        expect(
            await saveWorkspace(deps(storage), gameId, owner, {
                baseRevision: 0,
                sources: [
                    { path: 'b.ts' as WorkspacePath, contentType: 'text/typescript', text: '' },
                ],
                assets: [],
                deletes: [],
            }),
        ).toEqual({ outcome: 'stale', revision: 1 });
        expect(storage.versions.size).toBe(written);
    });

    it('records an asset from what landed in quarantine, and announces its inspection', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        await upload(storage, gameId, 'art/tile.png', PNG);

        const save = deps(storage);
        const saved = await saveWorkspace(save, gameId, owner, {
            baseRevision: 0,
            sources: [],
            assets: ['art/tile.png' as WorkspacePath],
            deletes: [],
        });
        expect(saved).toMatchObject({
            outcome: 'saved',
            workspace: {
                files: [
                    {
                        path: 'art/tile.png',
                        kind: 'asset',
                        byteLength: PNG.byteLength,
                        contentType: 'image/png',
                        versionId: storage.current(
                            uploadKey(gameId, 'art/tile.png' as WorkspacePath),
                        )?.versionId,
                    },
                ],
            },
        });
        expect(save.queue.pushed).toEqual([{ kind: 'ASSET_UPLOAD', taskId: expect.any(String) }]);
    });

    it('takes no upload of any length but the one its presign was signed for', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        const asked = await requestUpload(storage, 900, gameId, {
            path: 'art/tile.png' as WorkspacePath,
            contentType: 'image/png',
            byteLength: 4,
        });
        if (asked.outcome !== 'signed') throw new Error(asked.outcome);
        expect(asked.upload.headers).toEqual({ 'content-type': 'image/png' });
        expect(storage.send(asked.upload.url, PNG, asked.upload.headers).status).toBe(403);
        expect(storage.send(asked.upload.url, PNG.subarray(0, 4), {}).status).toBe(403);

        expect(
            await saveWorkspace(deps(storage), gameId, owner, {
                baseRevision: 0,
                sources: [],
                assets: ['art/tile.png' as WorkspacePath],
                deletes: [],
            }),
        ).toEqual({ outcome: 'not_uploaded', path: 'art/tile.png' });
    });

    it('takes an asset it already holds as no change, and queues no second inspection', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        await upload(storage, gameId, 'art/tile.png', PNG);
        const once = {
            baseRevision: 0,
            sources: [],
            assets: ['art/tile.png' as WorkspacePath],
            deletes: [],
        };
        await saveWorkspace(deps(storage), gameId, owner, once);

        const again = deps(storage);
        await saveWorkspace(again, gameId, owner, { ...once, baseRevision: 1 });
        expect(again.queue.pushed).toEqual([]);
    });

    it('marks what a save removed only once it has landed', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        await upload(storage, gameId, 'art/tile.png', PNG);
        await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 0,
            sources: [
                { path: 'main.ts' as WorkspacePath, contentType: 'text/typescript', text: '' },
            ],
            assets: ['art/tile.png' as WorkspacePath],
            deletes: [],
        });

        await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 1,
            sources: [
                { path: 'art/tile.png' as WorkspacePath, contentType: 'text/plain', text: 'x' },
            ],
            assets: [],
            deletes: ['main.ts' as WorkspacePath],
        });
        // The edge copy of an asset turned source goes, as does a deleted source.
        expect(storage.log.filter((line) => line.startsWith('remove')).toSorted()).toEqual([
            `remove ${objectKey(gameId, 'asset', 'art/tile.png' as WorkspacePath)}`,
            `remove ${objectKey(gameId, 'source', 'main.ts' as WorkspacePath)}`,
        ]);
    });

    it('refuses a source past the ceiling and an asset of a type the edge may not serve', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        expect(
            await saveWorkspace(deps(storage), gameId, owner, {
                baseRevision: 0,
                sources: [
                    {
                        path: 'big.ts' as WorkspacePath,
                        contentType: 'text/typescript',
                        text: 'é'.repeat(600_000),
                    },
                ],
                assets: [],
                deletes: [],
            }),
        ).toEqual({ outcome: 'too_large', path: 'big.ts' });

        await storage.put(uploadKey(gameId, 'page.html' as WorkspacePath), PNG, 'text/html');
        expect(
            await saveWorkspace(deps(storage), gameId, owner, {
                baseRevision: 0,
                sources: [],
                assets: ['page.html' as WorkspacePath],
                deletes: [],
            }),
        ).toEqual({ outcome: 'unacceptable', path: 'page.html' });
    });
});

describe('reading a file back', () => {
    it('serves an asset from quarantine until it is inspected, and from its edge copy after', async () => {
        const { owner, gameId } = await owned();
        const storage = bucket();
        await upload(storage, gameId, 'art/tile.png', PNG);
        const saved = await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 0,
            sources: [],
            assets: ['art/tile.png' as WorkspacePath],
            deletes: [],
        });
        if (saved.outcome !== 'saved') throw new Error(saved.outcome);
        const path = 'art/tile.png' as WorkspacePath;
        expect(
            await readFile({ workspaces: stores.workspaces, storage }, gameId, path),
        ).toMatchObject({
            byteLength: PNG.byteLength,
        });

        const copy = await storage.put(
            objectKey(gameId, 'asset', path),
            Buffer.from('copy'),
            'image/png',
        );
        if (copy.outcome !== 'written') throw new Error(copy.outcome);
        await harness.pg.query(
            `UPDATE "GameFile" SET "validatedVersionId" = "versionId", "edgeVersionId" = $1`,
            [copy.version.versionId],
        );
        expect(
            await readFile({ workspaces: stores.workspaces, storage }, gameId, path),
        ).toMatchObject({
            byteLength: 4,
        });
    });
});

describe('a publish', () => {
    async function savedGame(storage: Bucket, assets: WorkspacePath[] = []) {
        const { owner, gameId } = await owned();
        for (const path of assets) await upload(storage, gameId, path, PNG);
        const saved = await saveWorkspace(deps(storage), gameId, owner, {
            baseRevision: 0,
            sources: [
                { path: 'main.ts' as WorkspacePath, contentType: 'text/typescript', text: SOURCE },
            ],
            assets,
            deletes: [],
        });
        if (saved.outcome !== 'saved') throw new Error(saved.outcome);
        return { owner, gameId, saved: saved.workspace };
    }

    it('queues a build of the revision and save the last save froze, and announces it', async () => {
        const { owner, gameId, saved } = await savedGame(bucket());
        const queue = announcing();
        const published = await publish({ ...stores, queue, log: recordingLog() }, gameId, owner);
        if (published.outcome !== 'queued') throw new Error(published.outcome);
        expect(published.task).toMatchObject({ kind: 'BUILD', manifestRevision: 1 });
        expect(await stores.tasks.buildOf(published.task.taskId)).toMatchObject({
            saveId: saved.saveId,
        });
        expect(queue.pushed).toEqual([{ kind: 'BUILD', taskId: published.task.taskId }]);
        expect(await stores.games.publishedVersionOf(gameId)).toMatchObject({ revision: 1 });
    });

    it('is refused while an asset of that revision is unverified, and says which', async () => {
        const { owner, gameId } = await savedGame(bucket(), ['art/tile.png' as WorkspacePath]);
        const queue = announcing();
        expect(await publish({ ...stores, queue, log: recordingLog() }, gameId, owner)).toEqual({
            outcome: 'unverified',
            paths: ['art/tile.png'],
        });
        expect(queue.pushed).toEqual([]);
    });

    it('is refused for a game nobody has saved', async () => {
        const { owner, gameId } = await owned();
        expect(
            await publish({ ...stores, queue: announcing(), log: recordingLog() }, gameId, owner),
        ).toEqual({ outcome: 'unsaved' });
    });
});

describe('deleting a game', () => {
    it('erases its own prefix and its quarantine, then the row', async () => {
        const { gameId } = await owned();
        const storage = bucket();
        await upload(storage, gameId, 'art/tile.png', PNG);
        expect(await deleteGame({ games: stores.games, storage }, gameId)).toEqual({
            outcome: 'deleted',
        });
        expect(storage.log.filter((line) => line.startsWith('erase'))).toEqual([
            `erase ${gameId}/`,
            `erase uploads/${gameId}/`,
        ]);
        expect(storage.versions.size).toBe(0);
        expect(await stores.games.gameOf(gameId)).toBeUndefined();
    });
});

describe('a join', () => {
    async function joined(gameId: GameId, owner: PlayerId): Promise<string> {
        const version = {
            revision: 2,
            projectId: 'leaf-harvest',
            projectHash: 'b'.repeat(64),
            bundles: {} as never,
        };
        const played = await play(
            {
                games: { gameOf: stores.games.gameOf },
                tasks: { playableVersionOf: async () => version },
                fleet: {
                    place: async () => ({
                        sessionId: SESSION_ID,
                        serverUrl: 'wss://box.grove.example/play/abc',
                        revision: 2,
                    }),
                },
                signingKey: ticketSigningKey(TICKET_SEED),
            },
            gameId,
            owner,
            'req-1',
        );
        if (played.outcome !== 'placed') throw new Error(played.outcome);
        return played.session.ticket;
    }

    it('signs a ticket a box holding only the public key verifies', async () => {
        const { owner, gameId } = await owned();
        expect(
            verifyTicket(await joined(gameId, owner), [TICKET_KEY], Math.floor(Date.now() / 1000)),
        ).toMatchObject({ ok: true, claims: { gameId, playerId: owner, sessionId: SESSION_ID } });
    });

    // A box refuses a ticket it has seen, so two joins in one second must not share a ticket.
    it('mints a different ticket for the same join asked twice back to back', async () => {
        const { owner, gameId } = await owned();
        expect(await joined(gameId, owner)).not.toBe(await joined(gameId, owner));
    });
});

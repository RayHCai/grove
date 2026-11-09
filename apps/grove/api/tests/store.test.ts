// The accounts, games and workspace tables themselves, against a real Postgres: what a wrong
// password costs, what a reset key opens, and what a save may and may not leave behind.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    GameId,
    PlayerId,
    VersionId,
    type WorkspaceFile,
    type WorkspacePath,
} from '@grove/api-contract';
import type { FileUpsert, SavePlan, Stores } from '../src/records.js';
import { prismaStores } from '../src/store/index.js';
import { database, type Database } from './pglite.js';

const PASSWORD = 'a long enough password';

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

/** A distinct mailbox per account, so cases that make several do not collide on one address. */
let minted = 0;

async function withPassword(email = 'creator@grove.example'): Promise<PlayerId> {
    const created = await stores.accounts.createAccount(email, PASSWORD, 'Creator');
    if (created.outcome !== 'created') throw new Error(`expected created, got ${created.outcome}`);
    return created.account.playerId;
}

/** A fresh game belonging to a fresh account, which is what most cases below start from. */
async function owned(): Promise<{ owner: PlayerId; gameId: GameId }> {
    const owner = await withPassword(`creator-${String(minted++)}@grove.example`);
    const created = await stores.games.createGame(owner, 'My Game');
    if (created.outcome !== 'created') throw new Error('the game was not created');
    return { owner, gameId: created.game.gameId };
}

describe('an account with a password', () => {
    it('signs in, and hands back the id the wire calls a player', async () => {
        const playerId = await withPassword();
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBe(playerId);
        expect(PlayerId.safeParse(playerId).success).toBe(true);
    });

    it('signs in under the address spelled any way the person types it', async () => {
        await withPassword();
        expect(await stores.accounts.signIn('Creator@Grove.Example', PASSWORD)).toBeDefined();
    });

    it('cannot be registered twice for one mailbox, whatever the capitals', async () => {
        await withPassword();
        expect(
            (await stores.accounts.createAccount('CREATOR@grove.example', PASSWORD, 'B')).outcome,
        ).toBe('taken');
    });

    it('refuses the wrong password without saying the account exists', async () => {
        await withPassword();
        expect(await stores.accounts.signIn('creator@grove.example', 'not it')).toBeUndefined();
        expect(await stores.accounts.signIn('nobody@grove.example', PASSWORD)).toBeUndefined();
    });

    it('stores the password as argon2id and never hands it back', async () => {
        const playerId = await withPassword();
        const held = await harness.pg.query<{ hash: string }>(
            'SELECT "hash" FROM "PasswordCredential"',
        );
        expect(held.rows[0]?.hash).toMatch(/^\$argon2id\$v=19\$/u);
        expect(JSON.stringify(await stores.accounts.accountOf(playerId))).not.toContain('argon2');
    });

    it('locks itself after enough wrong guesses in a row, and the lock survives a right one', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.signIn('creator@grove.example', 'not it');
        }
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();

        const locked = await harness.pg.query<{ lockedUntil: Date | null; failedAttempts: number }>(
            'SELECT "lockedUntil", "failedAttempts" FROM "PasswordCredential"',
        );
        expect(locked.rows[0]?.failedAttempts).toBe(5);
        expect(locked.rows[0]?.lockedUntil).not.toBeNull();
    });

    it('forgets the failures once the right password does land', async () => {
        await withPassword();
        await stores.accounts.signIn('creator@grove.example', 'not it');
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeDefined();
        const after = await harness.pg.query<{ failedAttempts: number }>(
            'SELECT "failedAttempts" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(0);
    });

    it('signs in again once the lock it earned has passed', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.signIn('creator@grove.example', 'not it');
        }
        await harness.pg.query(
            `UPDATE "PasswordCredential" SET "lockedUntil" = now() - interval '1 second'`,
        );
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeDefined();
    });

    // Without decay, one wrong guess per ceiling keeps somebody out of their account for good.
    it('starts the count over when the last failure is older than the ceiling', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.signIn('creator@grove.example', 'not it');
        }
        await harness.pg.query(
            `UPDATE "PasswordCredential"
                SET "lockedUntil" = now() - interval '1 second',
                    "lastFailedAt" = now() - interval '1 hour'`,
        );
        await stores.accounts.signIn('creator@grove.example', 'not it');
        const after = await harness.pg.query<{ failedAttempts: number; lockedUntil: Date | null }>(
            'SELECT "failedAttempts", "lockedUntil" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(1);
        expect(after.rows[0]?.lockedUntil).toBeNull();
    });

    it('counts each guess exactly once, and stops the moment the lock arms', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 12; attempt += 1) {
            await stores.accounts.signIn('creator@grove.example', 'not it');
        }
        const after = await harness.pg.query<{ failedAttempts: number }>(
            'SELECT "failedAttempts" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(5);
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });
});

describe('changing and closing', () => {
    it('refuses the change to a caller who cannot produce the current password', async () => {
        const playerId = await withPassword();
        expect(
            (await stores.accounts.changePassword(playerId, 'not it', 'a different long one'))
                .outcome,
        ).toBe('wrong_password');
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeDefined();
    });

    it('makes the old password stop working and the new one start', async () => {
        const playerId = await withPassword();
        expect(
            (await stores.accounts.changePassword(playerId, PASSWORD, 'a different long one'))
                .outcome,
        ).toBe('ok');
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
        expect(
            await stores.accounts.signIn('creator@grove.example', 'a different long one'),
        ).toBeDefined();
    });

    it('refuses to close an account still owning a game', async () => {
        const playerId = await withPassword();
        await stores.games.createGame(playerId, 'My Game');
        expect((await stores.accounts.closeAccount(playerId, PASSWORD)).outcome).toBe('owns_games');
    });

    it('closes once the games are gone, and takes the credentials with it', async () => {
        const playerId = await withPassword();
        expect((await stores.accounts.closeAccount(playerId, PASSWORD)).outcome).toBe('closed');
        expect(await stores.accounts.accountOf(playerId)).toBeUndefined();
        expect((await harness.pg.query('SELECT 1 FROM "PasswordCredential"')).rows).toHaveLength(0);
    });

    it('refuses to close for a caller who brought no password at all', async () => {
        const playerId = await withPassword();
        expect((await stores.accounts.closeAccount(playerId, '')).outcome).toBe('wrong_password');
    });

    it('counts a failed re-auth the way a failed sign-in is counted', async () => {
        const playerId = await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.changePassword(playerId, 'not it', 'a different long one');
        }
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });

    it('counts a failed account close the same way', async () => {
        const playerId = await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.closeAccount(playerId, 'not it');
        }
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });

    it('renames, and says the account is gone once it is', async () => {
        const playerId = await withPassword();
        const renamed = await stores.accounts.renameAccount(playerId, 'Renamed');
        expect(renamed).toMatchObject({ outcome: 'renamed', account: { displayName: 'Renamed' } });

        await stores.accounts.closeAccount(playerId, PASSWORD);
        expect((await stores.accounts.renameAccount(playerId, 'Ghost')).outcome).toBe('missing');
    });
});

describe('a forgotten password', () => {
    async function keyFor(email = 'creator@grove.example'): Promise<string> {
        const begun = await stores.accounts.beginPasswordReset(email);
        if (begun.outcome !== 'begun') throw new Error(`expected begun, got ${begun.outcome}`);
        return begun.token;
    }

    it('mints a key for the address, and hands back where to send it', async () => {
        await withPassword();
        const begun = await stores.accounts.beginPasswordReset('Creator@Grove.Example');
        expect(begun).toMatchObject({ outcome: 'begun', email: 'creator@grove.example' });
        if (begun.outcome === 'begun') expect(begun.token.length).toBeGreaterThanOrEqual(43);
    });

    it('says nothing was begun for an address nobody holds', async () => {
        expect((await stores.accounts.beginPasswordReset('nobody@grove.example')).outcome).toBe(
            'no_account',
        );
    });

    it('never stores the key itself, only a digest of it', async () => {
        await withPassword();
        const token = await keyFor();
        const held = await harness.pg.query<{ tokenHash: Uint8Array }>(
            'SELECT "tokenHash" FROM "PasswordReset"',
        );
        expect(held.rows[0]?.tokenHash).toHaveLength(32);
        expect(Buffer.from(held.rows[0]?.tokenHash ?? []).toString('base64url')).not.toBe(token);
    });

    it('sets a new password, and the old one stops working', async () => {
        const playerId = await withPassword();
        const token = await keyFor();
        expect(
            await stores.accounts.finishPasswordReset(token, 'a brand new long password'),
        ).toEqual({ outcome: 'reset', player: playerId });
        expect(await stores.accounts.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
        expect(
            await stores.accounts.signIn('creator@grove.example', 'a brand new long password'),
        ).toBe(playerId);
    });

    it('opens once and never again', async () => {
        await withPassword();
        const token = await keyFor();
        expect(
            (await stores.accounts.finishPasswordReset(token, 'a brand new long password')).outcome,
        ).toBe('reset');
        expect(
            (await stores.accounts.finishPasswordReset(token, 'another long password here'))
                .outcome,
        ).toBe('refused');
    });

    it('refuses a key that was never minted, and one past its hour', async () => {
        await withPassword();
        expect(
            (await stores.accounts.finishPasswordReset('not a real key', 'a long enough one'))
                .outcome,
        ).toBe('refused');
        const token = await keyFor();
        await harness.pg.query(
            `UPDATE "PasswordReset"
                SET "createdAt" = now() - interval '2 hours',
                    "expiresAt" = now() - interval '1 hour'`,
        );
        expect(
            (await stores.accounts.finishPasswordReset(token, 'a brand new long password')).outcome,
        ).toBe('refused');
    });

    it('leaves one live key per account however many times it is asked', async () => {
        await withPassword();
        const first = await keyFor();
        const second = await keyFor();
        const third = await keyFor();

        const live = await harness.pg.query(
            'SELECT 1 FROM "PasswordReset" WHERE "consumedAt" IS NULL',
        );
        expect(live.rows).toHaveLength(1);
        for (const dead of [first, second]) {
            expect(
                (await stores.accounts.finishPasswordReset(dead, 'a brand new long password'))
                    .outcome,
            ).toBe('refused');
        }
        expect(
            (await stores.accounts.finishPasswordReset(third, 'a brand new long password')).outcome,
        ).toBe('reset');
    });

    // An unauthenticated form must not be a way to fill somebody's inbox.
    it('mails one address three times an hour and then withholds the fourth', async () => {
        await withPassword();
        for (let ask = 0; ask < 3; ask += 1) await keyFor();
        expect((await stores.accounts.beginPasswordReset('creator@grove.example')).outcome).toBe(
            'throttled',
        );

        // An hour on, the window is clear again.
        await harness.pg.query(
            `UPDATE "PasswordReset"
                SET "createdAt" = "createdAt" - interval '61 minutes',
                    "expiresAt" = "expiresAt" - interval '61 minutes'`,
        );
        expect((await stores.accounts.beginPasswordReset('creator@grove.example')).outcome).toBe(
            'begun',
        );
    });

    it('clears a lockout, so the reset is a way back in rather than a second door', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await stores.accounts.signIn('creator@grove.example', 'not it');
        }
        const token = await keyFor();
        await stores.accounts.finishPasswordReset(token, 'a brand new long password');
        expect(
            await stores.accounts.signIn('creator@grove.example', 'a brand new long password'),
        ).toBeDefined();
    });

    it('goes with the account when the account goes', async () => {
        const playerId = await withPassword();
        await keyFor();
        await stores.accounts.closeAccount(playerId, PASSWORD);
        expect((await harness.pg.query('SELECT 1 FROM "PasswordReset"')).rows).toHaveLength(0);
    });
});

describe('a game', () => {
    it('belongs to whoever made it, under an id the wire accepts', async () => {
        const { owner, gameId } = await owned();
        expect(await stores.games.ownerOf(gameId)).toBe(owner);
        expect(await stores.games.gameOf(gameId)).toMatchObject({
            ownerId: owner,
            publishedAt: null,
        });
    });

    it('is listed for its owner and for nobody else', async () => {
        const { owner } = await owned();
        const other = await withPassword('other@grove.example');
        expect((await stores.games.gamesOf(owner, 100)).games).toHaveLength(1);
        expect((await stores.games.gamesOf(other, 100)).games).toHaveLength(0);
    });

    it('is listed newest first, a page at a time, without a game twice or a game missed', async () => {
        const owner = await withPassword();
        const made: GameId[] = [];
        for (let at = 0; at < 5; at += 1) {
            const created = await stores.games.createGame(owner, `Game ${String(at)}`);
            if (created.outcome === 'created') made.push(created.game.gameId);
        }
        // Two pairs sharing a creation instant, which the id has to order between.
        await harness.pg.query(
            `UPDATE "Game" SET "createdAt" = '2026-11-01T00:00:00.000Z' WHERE "id" IN ($1, $2)`,
            [made[0], made[1]],
        );

        const seen: GameId[] = [];
        let after: Parameters<typeof stores.games.gamesOf>[2];
        for (let pages = 0; pages < 5; pages += 1) {
            const page = await stores.games.gamesOf(owner, 2, after);
            seen.push(...page.games.map((game) => game.gameId));
            if (page.next === undefined) break;
            after = page.next;
        }
        expect(seen.toSorted()).toEqual(made.toSorted());
        expect(new Set(seen).size).toBe(made.length);
    });

    it('is owned by nobody when no such game exists', async () => {
        expect(
            await stores.games.ownerOf(GameId.parse('00000000-0000-4000-8000-000000000000')),
        ).toBeUndefined();
    });

    it('starts private, and is whatever the owner last set it to', async () => {
        const { gameId } = await owned();
        expect(await stores.games.gameOf(gameId)).toMatchObject({ visibility: 'private' });
        expect(await stores.games.setVisibility(gameId, 'public')).toMatchObject({
            outcome: 'updated',
            game: { visibility: 'public' },
        });
        const gone = GameId.parse('00000000-0000-4000-8000-000000000001');
        expect(await stores.games.setVisibility(gone, 'public')).toEqual({ outcome: 'missing' });
    });

    it('records the last publish in two columns that cannot be set apart', async () => {
        const { gameId } = await owned();
        expect(await stores.games.publishedVersionOf(gameId)).toBeUndefined();
        const version = { revision: 3, publishedAt: '2026-09-16T10:00:00.000Z' };
        await stores.games.markPublished(gameId, version);
        expect(await stores.games.publishedVersionOf(gameId)).toEqual(version);
        await expect(
            harness.pg.exec(`UPDATE "Game" SET "publishedAt" = NULL WHERE "id" = '${gameId}'`),
        ).rejects.toThrow();
    });
});

const MAIN: FileUpsert = {
    path: 'main.ts' as WorkspacePath,
    kind: 'source',
    versionId: VersionId.parse('3.L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY'),
    byteLength: 34,
    contentType: 'text/typescript',
};
const ART: FileUpsert = {
    path: 'art/tile.png' as WorkspacePath,
    kind: 'asset',
    versionId: VersionId.parse('nc1Y9XTHvCvlLFtEZEoFsMWsp.LQ2cnI'),
    byteLength: 512,
    contentType: 'image/png',
};

/** A save of `upserts` and `deletes` off `held`, whose manifest froze the set it reaches. */
function plan(
    accountId: PlayerId,
    baseRevision: number,
    held: readonly WorkspaceFile[],
    upserts: FileUpsert[] = [],
    deletes: string[] = [],
): SavePlan {
    const touched = new Set([...deletes, ...upserts.map((file) => file.path)]);
    const frozen = [...held.filter((file) => !touched.has(file.path)), ...upserts].toSorted(
        (left, right) => (left.path < right.path ? -1 : 1),
    );
    return {
        baseRevision,
        saveId: crypto.randomUUID(),
        accountId,
        upserts,
        deletes: deletes as WorkspacePath[],
        frozen,
    };
}

describe("a game's workspace", () => {
    async function saved(gameId: GameId, request: SavePlan) {
        const outcome = await stores.workspaces.saveWorkspace(gameId, request);
        if (outcome.outcome !== 'saved') throw new Error(`expected saved, got ${outcome.outcome}`);
        return outcome;
    }

    it('starts empty at revision zero, and is nothing for a game that does not exist', async () => {
        const { gameId } = await owned();
        expect(await stores.workspaces.workspaceOf(gameId)).toMatchObject({
            revision: 0,
            files: [],
            saveId: undefined,
        });
        expect(
            await stores.workspaces.workspaceOf(
                GameId.parse('00000000-0000-4000-8000-000000000000'),
            ),
        ).toBeUndefined();
    });

    it('takes a save, moves one revision, and remembers the save that froze it', async () => {
        const { owner, gameId } = await owned();
        const request = plan(owner, 0, [], [MAIN, ART]);
        const { workspace } = await saved(gameId, request);

        expect(workspace.revision).toBe(1);
        expect(workspace.saveId).toBe(request.saveId);
        expect(workspace.files.map((file) => file.path)).toEqual(['art/tile.png', 'main.ts']);
    });

    it('merges into the set rather than replacing it, and removes exactly what it names', async () => {
        const { owner, gameId } = await owned();
        const first = await saved(gameId, plan(owner, 0, [], [MAIN]));
        const second = await saved(gameId, plan(owner, 1, first.workspace.files, [ART]));
        expect(second.workspace.files.map((file) => file.path)).toEqual([
            'art/tile.png',
            'main.ts',
        ]);

        const third = await saved(gameId, plan(owner, 2, second.workspace.files, [], ['main.ts']));
        expect(third.workspace.files.map((file) => file.path)).toEqual(['art/tile.png']);
    });

    it('refuses a save from a revision that has moved on, and says where it is', async () => {
        const { owner, gameId } = await owned();
        await saved(gameId, plan(owner, 0, [], [MAIN]));
        const late = await stores.workspaces.saveWorkspace(gameId, plan(owner, 0, [], [], []));
        expect(late).toMatchObject({ outcome: 'stale', workspace: { revision: 1 } });
    });

    // The manifest is written before the transaction, so rows that do not come to equal it are a
    // save that did not happen rather than a revision whose snapshot lies.
    it('rolls back a save whose rows would not be the set its manifest froze', async () => {
        const { owner, gameId } = await owned();
        const request = { ...plan(owner, 0, [], [MAIN]), frozen: [] };
        expect((await stores.workspaces.saveWorkspace(gameId, request)).outcome).toBe('stale');
        expect(await stores.workspaces.workspaceOf(gameId)).toMatchObject({
            revision: 0,
            files: [],
        });
    });

    it('queues one upload task per asset, pinned to the revision and the bytes it landed', async () => {
        const { owner, gameId } = await owned();
        const { tasks } = await saved(gameId, plan(owner, 0, [], [MAIN, ART]));
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            kind: 'ASSET_UPLOAD',
            assetPath: 'art/tile.png',
            manifestRevision: 1,
            status: 'NOT_STARTED',
        });
        expect(await stores.tasks.uploadOf(tasks[0]?.taskId as never)).toMatchObject({
            versionId: ART.versionId,
            byteLength: 512,
        });
    });

    it('cancels the inspection of bytes a later save replaced or removed', async () => {
        const { owner, gameId } = await owned();
        const first = await saved(gameId, plan(owner, 0, [], [ART]));
        const replaced = { ...ART, versionId: VersionId.parse('a.second.version') };
        await saved(gameId, plan(owner, 1, first.workspace.files, [replaced]));

        const rows = await harness.pg.query<{ status: string }>(
            `SELECT "status" FROM "Task" WHERE "id" = $1`,
            [first.tasks[0]?.taskId],
        );
        expect(rows.rows[0]?.status).toBe('CANCELLED');
    });

    // The verdict is about one byte-set, and a CHECK refuses one on a source.
    it('drops the verdict and the edge copy when a path turns from asset to source', async () => {
        const { owner, gameId } = await owned();
        const first = await saved(gameId, plan(owner, 0, [], [ART]));
        const task = first.tasks[0]?.taskId as never;
        await stores.tasks.claimTask(task, { kind: 'ASSET_UPLOAD', worker: 'w', leaseMs: 60_000 });
        await stores.tasks.settleTask(
            task,
            'ASSET_UPLOAD',
            { status: 'SUCCESSFUL', detail: { versionId: 'copy.1' } },
            VersionId.parse('copy.1'),
        );
        expect(await stores.workspaces.fileOf(gameId, ART.path)).toMatchObject({
            edgeVersionId: 'copy.1',
        });

        const asSource = { ...MAIN, path: ART.path };
        await saved(gameId, plan(owner, 1, first.workspace.files, [asSource]));
        expect(await stores.workspaces.fileOf(gameId, ART.path)).toMatchObject({
            kind: 'source',
            edgeVersionId: undefined,
        });
    });

    it('refuses a path or a version the wire shape would have refused, from any writer', async () => {
        const { gameId } = await owned();
        for (const [path, version] of [
            ['../escape.ts', 'v1'],
            ['main.ts', 'two words'],
        ]) {
            await expect(
                harness.pg.exec(
                    `INSERT INTO "GameFile" ("gameId", "path", "kind", "versionId", "byteLength",
                        "contentType", "updatedAt")
                     VALUES ('${gameId}', '${path}', 'source', '${version}', 1, 'text/plain', now())`,
                ),
            ).rejects.toThrow();
        }
    });

    it('refuses an edge copy no inspection passed', async () => {
        const { owner, gameId } = await owned();
        await saved(gameId, plan(owner, 0, [], [ART]));
        await expect(
            harness.pg.exec(
                `UPDATE "GameFile" SET "edgeVersionId" = 'copy.1' WHERE "gameId" = '${gameId}'`,
            ),
        ).rejects.toThrow();
    });

    it('goes with the game it belongs to', async () => {
        const { owner, gameId } = await owned();
        await saved(gameId, plan(owner, 0, [], [MAIN]));
        await harness.pg.exec(`DELETE FROM "Game" WHERE "id" = '${gameId}'`);
        const rows = await harness.pg.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM "GameFile"',
        );
        expect(rows.rows[0]?.n).toBe(0);
    });
});

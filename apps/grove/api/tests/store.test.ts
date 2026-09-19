// The accounts and games tables themselves, against a real Postgres: what a wrong password costs,
// and what a reset key opens and stops opening.
//
// Postgres runs in-process here, so this needs no container and no service in CI. The schema comes
// from the committed migrations rather than from `db push`, because half of what is asserted below
// is a CHECK constraint that only a migration carries.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
    GameId,
    PlayerId,
    VersionId,
    type BundleSet,
    type WorkspaceFile,
} from '@grove/api-contract';
import type { Records, SavePlan } from '../src/records.js';
import { connect, prismaRecords } from '../src/store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const PORT = 55432;
const PASSWORD = 'a long enough password';

let pg: PGlite;
let server: PGLiteSocketServer;
let db: PrismaClient;
let records: Records;

beforeAll(async () => {
    pg = await PGlite.create();
    // Every migration in the order a deploy applies them, rather than one named file: a schema
    // built from the first of several is one no deployed process ever runs against.
    for (const step of readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()) {
        await pg.exec(readFileSync(`${MIGRATIONS}/${step}/migration.sql`, 'utf8'));
    }
    server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
    await server.start();
    db = connect(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
    records = prismaRecords(db);
}, 60_000);

afterAll(async () => {
    await db?.$disconnect();
    await server?.stop();
    await pg?.close();
});

beforeEach(async () => {
    // One socket server means one connection at a time, so the tables are truncated rather than the
    // database being rebuilt per test.
    await pg.exec(
        'TRUNCATE "Account", "Game", "GameFile", "Task", "PasswordCredential", "PasswordReset" CASCADE',
    );
});

/** A distinct mailbox per game, so cases that make several do not collide on one address. */
let minted = 0;

async function withPassword(email = 'creator@grove.example'): Promise<PlayerId> {
    const created = await records.createAccount(email, PASSWORD, 'Creator');
    if (created.outcome !== 'created') throw new Error(`expected created, got ${created.outcome}`);
    return created.account.playerId;
}

describe('an account with a password', () => {
    it('signs in, and hands back the id the wire calls a player', async () => {
        const playerId = await withPassword();
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBe(playerId);
        expect(PlayerId.safeParse(playerId).success).toBe(true);
    });

    it('signs in under the address spelled any way the person types it', async () => {
        await withPassword();
        expect(await records.signIn('Creator@Grove.Example', PASSWORD)).toBeDefined();
    });

    it('cannot be registered twice for one mailbox, whatever the capitals', async () => {
        await withPassword();
        expect((await records.createAccount('CREATOR@grove.example', PASSWORD, 'B')).outcome).toBe(
            'taken',
        );
    });

    it('refuses the wrong password without saying the account exists', async () => {
        await withPassword();
        expect(await records.signIn('creator@grove.example', 'not it')).toBeUndefined();
        expect(await records.signIn('nobody@grove.example', PASSWORD)).toBeUndefined();
    });

    it('stores the password as argon2id and never hands it back', async () => {
        const playerId = await withPassword();
        const held = await pg.query<{ hash: string }>('SELECT "hash" FROM "PasswordCredential"');
        expect(held.rows[0]?.hash).toMatch(/^\$argon2id\$v=19\$/u);

        const account = await records.accountOf(playerId);
        expect(JSON.stringify(account)).not.toContain('argon2');
    });

    it('locks itself after enough wrong guesses in a row, and the lock survives a right one', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.signIn('creator@grove.example', 'not it');
        }
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();

        const locked = await pg.query<{ lockedUntil: Date | null; failedAttempts: number }>(
            'SELECT "lockedUntil", "failedAttempts" FROM "PasswordCredential"',
        );
        expect(locked.rows[0]?.failedAttempts).toBe(5);
        expect(locked.rows[0]?.lockedUntil).not.toBeNull();
    });

    it('forgets the failures once the right password does land', async () => {
        await withPassword();
        await records.signIn('creator@grove.example', 'not it');
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeDefined();

        const after = await pg.query<{ failedAttempts: number }>(
            'SELECT "failedAttempts" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(0);
    });

    it('signs in again once the lock it earned has passed', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.signIn('creator@grove.example', 'not it');
        }
        await pg.query(
            `UPDATE "PasswordCredential" SET "lockedUntil" = now() - interval '1 second'`,
        );
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeDefined();
    });

    // Without decay, one wrong guess per ceiling — 96 requests a day, from one address, well inside
    // the per-IP limiter — keeps somebody out of their account for good.
    it('starts the count over when the last failure is older than the ceiling', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.signIn('creator@grove.example', 'not it');
        }
        await pg.query(
            `UPDATE "PasswordCredential"
                SET "lockedUntil" = now() - interval '1 second',
                    "lastFailedAt" = now() - interval '1 hour'`,
        );

        await records.signIn('creator@grove.example', 'not it');
        const after = await pg.query<{ failedAttempts: number; lockedUntil: Date | null }>(
            'SELECT "failedAttempts", "lockedUntil" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(1);
        expect(after.rows[0]?.lockedUntil).toBeNull();
    });

    // The attempt is claimed before the verify is spent rather than counted after it, so a guess
    // cannot be checked against a count that has already moved. Postgres running in-process here
    // takes one connection at a time, so what this pins is that the claim counts exactly once and
    // stops dead on the lock; the row locking that makes it hold under a real burst is the
    // `FOR UPDATE` in the statement itself.
    it('counts each guess exactly once, and stops the moment the lock arms', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 12; attempt += 1) {
            await records.signIn('creator@grove.example', 'not it');
        }
        const after = await pg.query<{ failedAttempts: number }>(
            'SELECT "failedAttempts" FROM "PasswordCredential"',
        );
        expect(after.rows[0]?.failedAttempts).toBe(5);
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });
});

describe('changing and closing', () => {
    it('refuses the change to a caller who cannot produce the current password', async () => {
        const playerId = await withPassword();
        expect(
            (await records.changePassword(playerId, 'not it', 'a different long one')).outcome,
        ).toBe('wrong_password');
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeDefined();
    });

    it('makes the old password stop working and the new one start', async () => {
        const playerId = await withPassword();
        expect(
            (await records.changePassword(playerId, PASSWORD, 'a different long one')).outcome,
        ).toBe('ok');
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
        expect(await records.signIn('creator@grove.example', 'a different long one')).toBeDefined();
    });

    it('refuses to close an account still owning a game', async () => {
        const playerId = await withPassword();
        await records.createGame(playerId, 'My Game');
        expect((await records.closeAccount(playerId, PASSWORD)).outcome).toBe('owns_games');
    });

    it('closes once the games are gone, and takes the credentials with it', async () => {
        const playerId = await withPassword();
        expect((await records.closeAccount(playerId, PASSWORD)).outcome).toBe('closed');
        expect(await records.accountOf(playerId)).toBeUndefined();

        const left = await pg.query('SELECT 1 FROM "PasswordCredential"');
        expect(left.rows).toHaveLength(0);
    });

    it('refuses to close for a caller who brought no password at all', async () => {
        const playerId = await withPassword();
        expect((await records.closeAccount(playerId, '')).outcome).toBe('wrong_password');
    });

    // This route's scope carries no rate limiter, so the attempt counter is the only thing standing
    // between whoever is riding a session and unlimited guesses at the password it demands.
    it('counts a failed re-auth the way a failed sign-in is counted', async () => {
        const playerId = await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.changePassword(playerId, 'not it', 'a different long one');
        }
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });

    it('counts a failed account close the same way', async () => {
        const playerId = await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.closeAccount(playerId, 'not it');
        }
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
    });

    it('renames, and says the seam is empty rather than that the account is gone', async () => {
        const playerId = await withPassword();
        const renamed = await records.renameAccount(playerId, 'Renamed');
        expect(renamed.outcome).toBe('renamed');
        if (renamed.outcome !== 'renamed') return;
        expect(renamed.account.displayName).toBe('Renamed');

        await records.closeAccount(playerId, PASSWORD);
        expect((await records.renameAccount(playerId, 'Ghost')).outcome).toBe('missing');
    });
});

describe('a forgotten password', () => {
    async function keyFor(email = 'creator@grove.example'): Promise<string> {
        const begun = await records.beginPasswordReset(email);
        if (begun.outcome !== 'begun') throw new Error(`expected begun, got ${begun.outcome}`);
        return begun.token;
    }

    it('mints a key for the address, and hands back where to send it', async () => {
        await withPassword();
        const begun = await records.beginPasswordReset('Creator@Grove.Example');
        expect(begun.outcome).toBe('begun');
        if (begun.outcome !== 'begun') return;
        // Folded on the way in, and the stored address on the way out, so the mail goes where the
        // account actually is rather than to whatever capitals were typed.
        expect(begun.email).toBe('creator@grove.example');
        expect(begun.token.length).toBeGreaterThanOrEqual(43);
    });

    it('says nothing was begun for an address nobody holds', async () => {
        expect((await records.beginPasswordReset('nobody@grove.example')).outcome).toBe(
            'no_account',
        );
    });

    it('never stores the key itself, only a digest of it', async () => {
        await withPassword();
        const token = await keyFor();
        const held = await pg.query<{ tokenHash: Uint8Array }>(
            'SELECT "tokenHash" FROM "PasswordReset"',
        );
        expect(held.rows[0]?.tokenHash).toHaveLength(32);
        expect(Buffer.from(held.rows[0]?.tokenHash ?? []).toString('base64url')).not.toBe(token);
    });

    it('sets a new password, and the old one stops working', async () => {
        const playerId = await withPassword();
        const token = await keyFor();

        const finished = await records.finishPasswordReset(token, 'a brand new long password');
        expect(finished.outcome).toBe('reset');
        if (finished.outcome !== 'reset') return;
        expect(finished.player).toBe(playerId);

        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();
        expect(await records.signIn('creator@grove.example', 'a brand new long password')).toBe(
            playerId,
        );
    });

    it('opens once and never again', async () => {
        await withPassword();
        const token = await keyFor();
        expect(
            (await records.finishPasswordReset(token, 'a brand new long password')).outcome,
        ).toBe('reset');
        expect(
            (await records.finishPasswordReset(token, 'another long password here')).outcome,
        ).toBe('refused');
        // And the second attempt changed nothing.
        expect(
            await records.signIn('creator@grove.example', 'a brand new long password'),
        ).toBeDefined();
    });

    it('refuses a key that was never minted', async () => {
        await withPassword();
        expect(
            (await records.finishPasswordReset('not a real key', 'a long enough one')).outcome,
        ).toBe('refused');
    });

    it('refuses a key past its hour', async () => {
        await withPassword();
        const token = await keyFor();
        // Both columns, because the row carries a CHECK that a key may not be born already expired.
        await pg.query(
            `UPDATE "PasswordReset"
                SET "createdAt" = now() - interval '2 hours',
                    "expiresAt" = now() - interval '1 hour'`,
        );
        expect(
            (await records.finishPasswordReset(token, 'a brand new long password')).outcome,
        ).toBe('refused');
    });

    it('leaves one live key per account however many times it is asked', async () => {
        await withPassword();
        const first = await keyFor();
        const second = await keyFor();
        const third = await keyFor();

        const held = await pg.query('SELECT 1 FROM "PasswordReset"');
        expect(held.rows).toHaveLength(1);
        // The earlier links are dead, not merely unused — a mailbox full of them is not a mailbox
        // full of open doors.
        expect(
            (await records.finishPasswordReset(first, 'a brand new long password')).outcome,
        ).toBe('refused');
        expect(
            (await records.finishPasswordReset(second, 'a brand new long password')).outcome,
        ).toBe('refused');
        expect(
            (await records.finishPasswordReset(third, 'a brand new long password')).outcome,
        ).toBe('reset');
    });

    // The whole point of resetting: somebody who locked themselves out guessing has to get back in.
    it('clears a lockout, so the reset is a way back in rather than a second door', async () => {
        await withPassword();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await records.signIn('creator@grove.example', 'not it');
        }
        expect(await records.signIn('creator@grove.example', PASSWORD)).toBeUndefined();

        const token = await keyFor();
        expect(
            (await records.finishPasswordReset(token, 'a brand new long password')).outcome,
        ).toBe('reset');
        expect(
            await records.signIn('creator@grove.example', 'a brand new long password'),
        ).toBeDefined();
    });

    it('goes with the account when the account goes', async () => {
        const playerId = await withPassword();
        await keyFor();
        await records.closeAccount(playerId, PASSWORD);
        expect((await pg.query('SELECT 1 FROM "PasswordReset"')).rows).toHaveLength(0);
    });
});

describe('a game', () => {
    it('belongs to whoever made it, under an id the wire accepts', async () => {
        const playerId = await withPassword();
        const created = await records.createGame(playerId, 'My Game');
        expect(created.outcome).toBe('created');
        if (created.outcome !== 'created') return;
        expect(created.game.ownerId).toBe(playerId);
        expect(await records.ownerOf(created.game.gameId)).toBe(playerId);
    });

    it('is listed for its owner and for nobody else', async () => {
        const owner = await withPassword();
        const other = await withPassword('other@grove.example');
        await records.createGame(owner, 'Mine');

        expect(await records.gamesOf(owner)).toHaveLength(1);
        expect(await records.gamesOf(other)).toHaveLength(0);
    });

    it('is owned by nobody when no such game exists', async () => {
        expect(await records.ownerOf(GameId.parse('00000000-0000-4000-8000-000000000000'))).toBe(
            undefined,
        );
    });
});

/** A save of `upserts` and `deletes` whose manifest the bucket takes. */
function plan(
    accountId: PlayerId,
    baseRevision: number,
    upserts: WorkspaceFile[] = [],
    deletes: string[] = [],
    freeze: SavePlan['freeze'] = async () => true,
): SavePlan {
    return { baseRevision, accountId, upserts, deletes: deletes as SavePlan['deletes'], freeze };
}

describe("a game's workspace", () => {
    const main: WorkspaceFile = {
        path: 'main.ts',
        kind: 'source',
        versionId: VersionId.parse('3.L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY'),
        byteLength: 34,
        contentType: 'text/typescript',
    };
    const art: WorkspaceFile = {
        path: 'art/tile.png',
        kind: 'asset',
        versionId: VersionId.parse('nc1Y9XTHvCvlLFtEZEoFsMWsp.LQ2cnI'),
        byteLength: 512,
        contentType: 'image/png',
    };

    /** A fresh game belonging to a fresh account, which is what every case below starts from. */
    async function owned(): Promise<{ owner: PlayerId; gameId: GameId }> {
        const owner = await withPassword(`creator-${String(minted++)}@grove.example`);
        const created = await records.createGame(owner, 'My Game');
        if (created.outcome !== 'created') throw new Error('the game was not created');
        return { owner, gameId: created.game.gameId };
    }

    it('starts empty at revision zero, which is a game an editor has not saved', async () => {
        expect(await records.workspaceOf((await owned()).gameId)).toMatchObject({
            revision: 0,
            files: [],
        });
    });

    it('is nothing at all for a game that does not exist', async () => {
        expect(
            await records.workspaceOf(GameId.parse('00000000-0000-4000-8000-000000000000')),
        ).toBeUndefined();
    });

    it('takes a save and moves one revision, in path order', async () => {
        const { owner, gameId } = await owned();
        const saved = await records.saveWorkspace(gameId, plan(owner, 0, [main, art]));

        expect(saved.outcome).toBe('saved');
        if (saved.outcome !== 'saved') return;
        expect(saved.workspace.revision).toBe(1);
        expect(saved.workspace.files.map((file) => file.path)).toEqual(['art/tile.png', 'main.ts']);
        expect(saved.workspace.files[1]).toEqual(main);
    });

    it('merges into the set rather than replacing it, which is what makes a save a delta', async () => {
        const { owner, gameId } = await owned();
        await records.saveWorkspace(gameId, plan(owner, 0, [main]));
        await records.saveWorkspace(gameId, plan(owner, 1, [art]));

        const workspace = await records.workspaceOf(gameId);
        expect(workspace?.files.map((file) => file.path)).toEqual(['art/tile.png', 'main.ts']);
        expect(workspace?.revision).toBe(2);
    });

    it('removes exactly the paths a save named', async () => {
        const { owner, gameId } = await owned();
        await records.saveWorkspace(gameId, plan(owner, 0, [main, art]));
        await records.saveWorkspace(gameId, plan(owner, 1, [], ['main.ts']));

        expect((await records.workspaceOf(gameId))?.files.map((file) => file.path)).toEqual([
            'art/tile.png',
        ]);
    });

    it('takes a new version at a path that already had one', async () => {
        const { owner, gameId } = await owned();
        await records.saveWorkspace(gameId, plan(owner, 0, [main]));
        const moved = { ...main, versionId: VersionId.parse('WBGa5vvi7.5.0Wq'), byteLength: 40 };
        await records.saveWorkspace(gameId, plan(owner, 1, [moved]));

        expect((await records.workspaceOf(gameId))?.files).toEqual([moved]);
    });

    it('freezes the whole set under the revision it claimed, not only what changed', async () => {
        const { owner, gameId } = await owned();
        const frozen: { revision: number; paths: string[] }[] = [];
        const keep: SavePlan['freeze'] = async (revision, files) => {
            frozen.push({ revision, paths: files.map((file) => file.path) });
            return true;
        };

        await records.saveWorkspace(gameId, plan(owner, 0, [main], [], keep));
        await records.saveWorkspace(gameId, plan(owner, 1, [art], [], keep));

        expect(frozen).toEqual([
            { revision: 1, paths: ['main.ts'] },
            { revision: 2, paths: ['art/tile.png', 'main.ts'] },
        ]);
    });

    it('rolls the whole save back when the manifest could not be written', async () => {
        const { owner, gameId } = await owned();
        const refused = await records.saveWorkspace(
            gameId,
            plan(owner, 0, [main], [], async () => false),
        );

        expect(refused.outcome).toBe('unfrozen');
        // A revision no manifest names is exactly what rolling back here exists to prevent.
        expect(await records.workspaceOf(gameId)).toMatchObject({ revision: 0, files: [] });
    });

    it('queues one task per asset, pinned to the revision that landed it', async () => {
        const { owner, gameId } = await owned();
        const saved = await records.saveWorkspace(gameId, plan(owner, 0, [main, art]));

        if (saved.outcome !== 'saved') throw new Error(`expected saved, got ${saved.outcome}`);
        expect(saved.tasks).toHaveLength(1);
        expect(saved.tasks[0]).toMatchObject({
            kind: 'ASSET_UPLOAD',
            assetPath: 'art/tile.png',
            manifestRevision: 1,
            status: 'NOT_STARTED',
        });
    });

    it('queues nothing at all for a save of source alone', async () => {
        const { owner, gameId } = await owned();
        const saved = await records.saveWorkspace(gameId, plan(owner, 0, [main]));
        if (saved.outcome !== 'saved') throw new Error(`expected saved, got ${saved.outcome}`);
        expect(saved.tasks).toEqual([]);
    });

    it('refuses a save from a revision that has moved on, and says where it is', async () => {
        const { owner, gameId } = await owned();
        await records.saveWorkspace(gameId, plan(owner, 0, [main]));
        const late = await records.saveWorkspace(gameId, plan(owner, 0, [], ['main.ts']));

        expect(late.outcome).toBe('stale');
        if (late.outcome !== 'stale') return;
        expect(late.workspace.revision).toBe(1);
        // The set the winner wrote, untouched: a refused save must not have written half of itself.
        expect(late.workspace.files).toEqual([main]);
    });

    it('says the game is missing rather than inventing a revision for it', async () => {
        const { owner } = await owned();
        const absent = GameId.parse('00000000-0000-4000-8000-000000000000');
        expect(await records.saveWorkspace(absent, plan(owner, 0))).toEqual({ outcome: 'missing' });
    });

    it('refuses a path the wire shape would have refused, from any writer', async () => {
        const { gameId } = await owned();
        await expect(
            pg.exec(
                `INSERT INTO "GameFile" ("gameId", "path", "kind", "versionId", "byteLength",
                    "contentType", "updatedAt")
                 VALUES ('${gameId}', '../escape.ts', 'source', 'v1', 1, 'text/plain', now())`,
            ),
        ).rejects.toThrow();
    });

    it('refuses a version id no bucket would have minted', async () => {
        const { gameId } = await owned();
        await expect(
            pg.exec(
                `INSERT INTO "GameFile" ("gameId", "path", "kind", "versionId", "byteLength",
                    "contentType", "updatedAt")
                 VALUES ('${gameId}', 'main.ts', 'source', 'two words', 1, 'text/plain', now())`,
            ),
        ).rejects.toThrow();
    });

    it('goes with the game it belongs to', async () => {
        const { owner, gameId } = await owned();
        await records.saveWorkspace(gameId, plan(owner, 0, [main]));
        await pg.exec(`DELETE FROM "Game" WHERE "id" = '${gameId}'`);

        const rows = await pg.query('SELECT count(*)::int AS n FROM "GameFile"');
        expect((rows.rows[0] as { n: number }).n).toBe(0);
    });
});

describe('a published version', () => {
    const version = { revision: 3, publishedAt: '2026-09-16T10:00:00.000Z' };

    async function game(): Promise<GameId> {
        const created = await records.createGame(
            await withPassword(`creator-${String(minted++)}@grove.example`),
            'My Game',
        );
        if (created.outcome !== 'created') throw new Error('the game was not created');
        return created.game.gameId;
    }

    it('is nothing until one is published', async () => {
        expect(await records.publishedVersionOf(await game())).toBeUndefined();
    });

    it('is the manifest revision the last publish named', async () => {
        const gameId = await game();
        await records.markPublished(gameId, version);
        expect(await records.publishedVersionOf(gameId)).toEqual(version);
    });

    it('is replaced by the next publish rather than kept beside it', async () => {
        const gameId = await game();
        await records.markPublished(gameId, version);
        const next = { revision: 4, publishedAt: '2026-09-16T11:00:00.000Z' };
        await records.markPublished(gameId, next);

        expect(await records.publishedVersionOf(gameId)).toEqual(next);
    });

    it('is two columns that cannot be set apart from each other', async () => {
        const gameId = await game();
        await expect(
            pg.exec(`UPDATE "Game" SET "publishedRevision" = 3 WHERE "id" = '${gameId}'`),
        ).rejects.toThrow();
    });
});

const HASH = 'a'.repeat(64);

function bundles(hash = HASH): BundleSet {
    return {
        server: {
            side: 'server',
            hash,
            url: `https://cdn.grove.example/b/${hash}`,
            byteLength: 81_920,
        },
        client: {
            side: 'client',
            hash,
            url: `https://cdn.grove.example/b/${hash}`,
            byteLength: 65_536,
        },
        simConfig: {
            hash,
            url: `https://cdn.grove.example/b/${hash}.json`,
            byteLength: 128,
        },
        syncedHash: hash,
    };
}

describe('a playable version', () => {
    let owner: PlayerId;
    let gameId: GameId;

    beforeEach(async () => {
        owner = await withPassword(`creator-${String(minted++)}@grove.example`);
        const created = await records.createGame(owner, 'My Game');
        if (created.outcome !== 'created') throw new Error('the game was not created');
        gameId = created.game.gameId;
    });

    /** Queues a build of `revision` and settles it however this case needs. */
    async function build(revision: number, update: Parameters<Records['advanceTask']>[1]) {
        const queued = await records.queueTask(gameId, owner, 'BUILD', revision);
        if (queued.outcome !== 'queued') throw new Error('the build was not queued');
        await records.advanceTask(queued.task.taskId, { status: 'IN_PROGRESS' });
        await records.advanceTask(queued.task.taskId, update);
    }

    it('is nothing while no build has finished', async () => {
        expect(await records.playableVersionOf(gameId)).toBeUndefined();

        await build(1, { status: 'IN_PROGRESS' });
        expect(await records.playableVersionOf(gameId)).toBeUndefined();
    });

    it('is the newest build that succeeded, and never the newest one queued', async () => {
        await build(1, { status: 'SUCCESSFUL', detail: { bundles: bundles() } });
        // A later revision that failed leaves the earlier one playable: a creator who breaks their
        // game does not take the version everybody is already playing down with it.
        await build(2, { status: 'FAILED', detail: { message: 'it did not compile' } });

        expect(await records.playableVersionOf(gameId)).toEqual({
            revision: 1,
            bundles: bundles(),
        });
    });

    it('is ordered by the revision rather than by which build finished last', async () => {
        const later = 'b'.repeat(64);
        await build(4, { status: 'SUCCESSFUL', detail: { bundles: bundles(later) } });
        await build(2, { status: 'SUCCESSFUL', detail: { bundles: bundles() } });

        expect(await records.playableVersionOf(gameId)).toMatchObject({ revision: 4 });
    });

    it('is nothing for a build that registered no bundle set', async () => {
        // A worker that settled outside its own contract. Answering the revision anyway would send
        // a player at a version naming no code, which fails on a box instead of here.
        await build(1, { status: 'SUCCESSFUL', detail: { diagnostics: [] } });
        expect(await records.playableVersionOf(gameId)).toBeUndefined();
    });
});

describe("a game's visibility", () => {
    let gameId: GameId;

    beforeEach(async () => {
        const owner = await withPassword(`creator-${String(minted++)}@grove.example`);
        const created = await records.createGame(owner, 'My Game');
        if (created.outcome !== 'created') throw new Error('the game was not created');
        gameId = created.game.gameId;
    });

    it('starts private, because building one is not sharing it', async () => {
        expect(await records.gameOf(gameId)).toMatchObject({ visibility: 'private' });
    });

    it('is what the owner last set it to', async () => {
        expect(await records.setVisibility(gameId, 'public')).toMatchObject({
            outcome: 'updated',
            game: { visibility: 'public' },
        });
        expect(await records.gameOf(gameId)).toMatchObject({ visibility: 'public' });
    });

    it('is nothing to set on a game that is not there', async () => {
        const gone = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
        expect(await records.setVisibility(gone, 'public')).toEqual({ outcome: 'missing' });
        expect(await records.gameOf(gone)).toBeUndefined();
    });
});

describe('a queued task', () => {
    async function owned(): Promise<{ owner: PlayerId; gameId: GameId }> {
        const owner = await withPassword(`creator-${String(minted++)}@grove.example`);
        const created = await records.createGame(owner, 'My Game');
        if (created.outcome !== 'created') throw new Error('the game was not created');
        return { owner, gameId: created.game.gameId };
    }

    it('is created unclaimed, pinned to the manifest it was asked for', async () => {
        const { owner, gameId } = await owned();
        const queued = await records.queueTask(gameId, owner, 'BUILD', 4);

        expect(queued.outcome).toBe('queued');
        if (queued.outcome !== 'queued') return;
        expect(queued.task).toMatchObject({
            gameId,
            kind: 'BUILD',
            status: 'NOT_STARTED',
            manifestRevision: 4,
            attempts: 0,
        });
        expect(queued.task.assetPath).toBeUndefined();
    });

    it('is handed back rather than made twice for one manifest', async () => {
        const { owner, gameId } = await owned();
        const first = await records.queueTask(gameId, owner, 'BUILD', 4);
        const second = await records.queueTask(gameId, owner, 'BUILD', 4);

        expect(second.outcome).toBe('existing');
        if (first.outcome !== 'queued' || second.outcome !== 'existing') return;
        expect(second.task.taskId).toBe(first.task.taskId);
    });

    it('is made again once the one before it settled, which is what a rebuild is', async () => {
        const { owner, gameId } = await owned();
        const first = await records.queueTask(gameId, owner, 'BUILD', 4);
        if (first.outcome !== 'queued') throw new Error('the task was not queued');
        await records.advanceTask(first.task.taskId, { status: 'FAILED' });

        const again = await records.queueTask(gameId, owner, 'BUILD', 4);
        expect(again.outcome).toBe('queued');
        if (again.outcome !== 'queued') return;
        expect(again.task.taskId).not.toBe(first.task.taskId);
    });

    it('says the game is missing rather than queueing work nothing can settle', async () => {
        const { owner } = await owned();
        const absent = GameId.parse('00000000-0000-4000-8000-000000000000');
        expect(await records.queueTask(absent, owner, 'BUILD', 1)).toEqual({ outcome: 'missing' });
    });

    it('counts an attempt on every claim, and dates the start', async () => {
        const { owner, gameId } = await owned();
        const queued = await records.queueTask(gameId, owner, 'BUILD', 4);
        if (queued.outcome !== 'queued') throw new Error('the task was not queued');

        const claimed = await records.advanceTask(queued.task.taskId, { status: 'IN_PROGRESS' });
        expect(claimed.outcome).toBe('advanced');
        if (claimed.outcome !== 'advanced') return;
        expect(claimed.task.attempts).toBe(1);
        expect(claimed.task.startedAt).toBeDefined();
        expect(claimed.task.finishedAt).toBeUndefined();
    });

    it('cannot be walked back once it has settled', async () => {
        const { owner, gameId } = await owned();
        const queued = await records.queueTask(gameId, owner, 'BUILD', 4);
        if (queued.outcome !== 'queued') throw new Error('the task was not queued');

        await records.advanceTask(queued.task.taskId, { status: 'IN_PROGRESS' });
        await records.advanceTask(queued.task.taskId, { status: 'SUCCESSFUL' });
        const again = await records.advanceTask(queued.task.taskId, { status: 'IN_PROGRESS' });

        expect(again.outcome).toBe('backwards');
        if (again.outcome !== 'backwards') return;
        expect(again.task.status).toBe('SUCCESSFUL');
    });

    it('carries what the worker had to say about it', async () => {
        const { owner, gameId } = await owned();
        const queued = await records.queueTask(gameId, owner, 'BUILD', 4);
        if (queued.outcome !== 'queued') throw new Error('the task was not queued');

        const settled = await records.advanceTask(queued.task.taskId, {
            status: 'FAILED',
            detail: {
                diagnostics: [
                    { severity: 'error', file: 'main.ts', line: 3, column: 1, message: 'no' },
                ],
            },
        });
        if (settled.outcome !== 'advanced') throw new Error('the task did not advance');
        expect(settled.task.detail?.diagnostics?.[0]?.message).toBe('no');
        // A finish with no start is a lifecycle the CHECK refuses, so settling one that was never
        // claimed has to date both.
        expect(settled.task.startedAt).toBeDefined();
        expect(settled.task.finishedAt).toBeDefined();
    });

    it('is nothing at all when read through a game it does not belong to', async () => {
        const { owner, gameId } = await owned();
        const other = await owned();
        const queued = await records.queueTask(gameId, owner, 'BUILD', 4);
        if (queued.outcome !== 'queued') throw new Error('the task was not queued');

        expect(await records.taskOf(other.gameId, queued.task.taskId)).toBeUndefined();
        expect(await records.taskOf(gameId, queued.task.taskId)).toMatchObject({ gameId });
    });

    it('is what the sweeper reads: unclaimed, of one kind, older than a cutoff', async () => {
        const { owner, gameId } = await owned();
        const stale = await records.queueTask(gameId, owner, 'BUILD', 4);
        const claimed = await records.queueTask(gameId, owner, 'BUILD', 5);
        if (stale.outcome !== 'queued' || claimed.outcome !== 'queued') return;
        await records.advanceTask(claimed.task.taskId, { status: 'IN_PROGRESS' });

        const ahead = new Date(Date.now() + 60_000);
        expect(
            (await records.unclaimedTasks('BUILD', ahead, 10)).map((task) => task.taskId),
        ).toEqual([stale.task.taskId]);
        // A consumer group already redelivers what a dead worker claimed, so IN_PROGRESS is the
        // stream's problem and never this one's.
        expect(await records.unclaimedTasks('ASSET_UPLOAD', ahead, 10)).toEqual([]);
    });

    it('refuses a build row that names an asset, and an upload row that names none', async () => {
        const { owner, gameId } = await owned();
        const row = (kind: string, path: string): string =>
            `INSERT INTO "Task" ("gameId", "accountId", "kind", "manifestRevision", "assetPath",
                "updatedAt")
             VALUES ('${gameId}', '${owner}', '${kind}', 1, ${path}, now())`;

        await expect(pg.exec(row('BUILD', `'art/tile.png'`))).rejects.toThrow();
        await expect(pg.exec(row('ASSET_UPLOAD', 'NULL'))).rejects.toThrow();
    });
});

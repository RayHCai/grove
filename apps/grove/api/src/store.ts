import { createHash, randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
    BundleSet,
    FileKind,
    GameId,
    GameVisibility,
    MediaType,
    PlayerId,
    Task,
    VersionId,
    WorkspacePath,
    isTerminal,
    type WorkspaceFile,
} from '@grove/api-contract';
import { hashPassword, verifyPassword } from './passwords.js';
import type {
    AccountRecord,
    GameRecord,
    Records,
    WorkspaceRecord,
    WorkspaceSaved,
} from './records.js';
import { PrismaClient } from './generated/prisma/client.js';
import type { Account, Game, Task as TaskRow } from './generated/prisma/client.js';
import { foldEmail } from './values.js';

/** Postgres refused a write because a unique index already held the value. */
const UNIQUE_VIOLATION = 'P2002';
/** Postgres refused a delete because a row still points at it. */
const FOREIGN_KEY_VIOLATION = 'P2003';
/** The row a write named was not there to write. */
const RECORD_NOT_FOUND = 'P2025';

/** Long enough that the mail sits in an inbox, short enough that a forwarded one goes stale. */
const RESET_TTL_MS = 60 * 60 * 1000;

/** 256 bits, so the digest below is the only thing standing between a guess and an account. */
function mintToken(): string {
    return randomBytes(32).toString('base64url');
}

/**
 * The value the row is found by.
 *
 * SHA-256 rather than argon2, deliberately: a lookup has to be deterministic, and the secret is 32
 * random bytes rather than something a person chose, so there is no dictionary for a salt to defeat.
 */
function digest(token: string): Uint8Array<ArrayBuffer> {
    // Copied into an ArrayBuffer of its own rather than handed over as the Buffer the hash returns:
    // Prisma types a `Bytes` column as a `Uint8Array<ArrayBuffer>`, and a Buffer is a view into a
    // pool it shares with whatever else allocated nearby.
    const hashed = createHash('sha256').update(token).digest();
    const bytes = new Uint8Array(new ArrayBuffer(hashed.byteLength));
    bytes.set(hashed);
    return bytes;
}

export function connect(databaseUrl: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

function codeOf(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
}

type AccountRow = Account & { password: { accountId: string } | null };

/** Prisma hands back plain strings; parsing is what proves the column holds a wire-legal id. */
function asAccount(row: AccountRow): AccountRecord {
    return {
        playerId: PlayerId.parse(row.id),
        email: row.email,
        displayName: row.displayName,
        createdAt: row.createdAt.toISOString(),
    };
}

function asGame(row: Game): GameRecord {
    return {
        gameId: GameId.parse(row.id),
        ownerId: PlayerId.parse(row.ownerId),
        title: row.title,
        visibility: GameVisibility.parse(row.visibility),
        createdAt: row.createdAt.toISOString(),
    };
}

interface FileRow {
    path: string;
    kind: string;
    versionId: string;
    byteLength: number;
    contentType: string;
}

interface WorkspaceRow {
    id: string;
    draftRevision: number;
    updatedAt: Date;
    files: FileRow[];
}

/** Parsed rather than cast: a manifest is built from these columns, and a version the bucket will
 * never answer for is a build that fails minutes later with no line to point at. */
function asFile(row: FileRow): WorkspaceFile {
    return {
        path: WorkspacePath.parse(row.path),
        kind: FileKind.parse(row.kind),
        versionId: VersionId.parse(row.versionId),
        byteLength: row.byteLength,
        contentType: MediaType.parse(row.contentType),
    };
}

function asWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return {
        gameId: GameId.parse(row.id),
        revision: row.draftRevision,
        files: row.files.map(asFile),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** An optional column reaches the wire shape by being absent, never by being null. */
function asTask(row: TaskRow): Task {
    return Task.parse({
        taskId: row.id,
        gameId: row.gameId,
        kind: row.kind,
        status: row.status,
        manifestRevision: row.manifestRevision,
        ...(row.assetPath === null ? {} : { assetPath: row.assetPath }),
        attempts: row.attempts,
        ...(row.detail === null ? {} : { detail: row.detail }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
        ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    });
}

/** The set a task is live in, which is the set the partial unique index is built over. */
const LIVE = ['NOT_STARTED', 'IN_PROGRESS'] as const;

/** Thrown to roll a save back when the manifest could not be written; never leaves this module. */
class ManifestRefused extends Error {}

const WORKSPACE_SELECT = {
    id: true,
    draftRevision: true,
    updatedAt: true,
    files: {
        select: {
            path: true,
            kind: true,
            versionId: true,
            byteLength: true,
            contentType: true,
        },
        // Path order, so two reads of one revision are the same bytes and the manifest a save
        // freezes does not depend on the planner.
        orderBy: { path: 'asc' },
    },
} as const;

const WITH_PASSWORD = { password: { select: { accountId: true } } };

/**
 * The accounts and games tables behind the records seam.
 *
 * Every method answers an outcome rather than throwing: a Prisma error's message names the model and
 * the constraint that failed, and `installErrorHandler` puts a sub-500 message straight on the wire.
 */
export function prismaRecords(db: PrismaClient): Records {
    return {
        signIn: async (email, password) => {
            // Folded on the way in as well as on the way out, or an address stored lowercase is
            // unreachable to the person who typed it with a capital.
            const claimed = await claimAttempt(db, { email: foldEmail(email) });
            // The verify runs against the dummy whenever the claim handed back no hash — an unknown
            // address, an account that holds no password, and a locked one all land here —
            // and it runs before the branch rather than inside it, so no answer is reached without
            // paying argon2 for it. That is one statement and one verify on every path; what is
            // left is whether the join found a row at all, measured at 0.4 ms against a 12.7 ms
            // floor, and an address that already has an account is a fact sign-up answers outright.
            const matched = await verifyPassword(claimed?.hash, password);
            if (claimed === undefined || !matched) return undefined;

            await clearAttempts(db, claimed.accountId);
            return PlayerId.parse(claimed.accountId);
        },

        ownerOf: async (game) => {
            const row = await db.game.findUnique({
                where: { id: game },
                select: { ownerId: true },
            });
            return row === null ? undefined : PlayerId.parse(row.ownerId);
        },

        createAccount: async (email, password, displayName) => {
            const hash = await hashPassword(password);
            try {
                const account = await db.account.create({
                    data: { email: foldEmail(email), displayName, password: { create: { hash } } },
                    include: WITH_PASSWORD,
                });
                return { outcome: 'created', account: asAccount(account) };
            } catch (error) {
                if (codeOf(error) === UNIQUE_VIOLATION) return { outcome: 'taken' };
                throw error;
            }
        },

        accountOf: async (player) => {
            const row = await db.account.findUnique({
                where: { id: player },
                include: WITH_PASSWORD,
            });
            return row === null ? undefined : asAccount(row);
        },

        profileOf: async (player) => {
            const row = await db.account.findUnique({
                where: { id: player },
                select: { id: true, displayName: true },
            });
            return row === null
                ? undefined
                : { playerId: PlayerId.parse(row.id), displayName: row.displayName };
        },

        renameAccount: async (player, displayName) => {
            const row = await db.account
                .update({ where: { id: player }, data: { displayName }, include: WITH_PASSWORD })
                .catch((error: unknown) => {
                    // Only "no such row" is an answer; anything else is the database failing, and
                    // reporting that as a missing account would send a creator the wrong way.
                    if (codeOf(error) === RECORD_NOT_FOUND) return null;
                    throw error;
                });
            return row === null
                ? { outcome: 'missing' }
                : { outcome: 'renamed', account: asAccount(row) };
        },

        changePassword: async (player, current, next) => {
            // Through the same claim a sign-in spends, so the re-auth this route demands cannot be
            // guessed at unlimited speed by whoever is riding the session. Its scope carries no
            // limiter, which makes the counter the only thing rationing it.
            const claimed = await claimAttempt(db, { accountId: player });
            if (!(await verifyPassword(claimed?.hash, current)))
                return { outcome: 'wrong_password' };

            await db.passwordCredential.update({
                where: { accountId: player },
                data: {
                    hash: await hashPassword(next),
                    failedAttempts: 0,
                    lastFailedAt: null,
                    lockedUntil: null,
                },
            });
            return { outcome: 'ok' };
        },

        closeAccount: async (player, current) => {
            // Counted the same way a sign-in is, because this route sits behind a session on a
            // scope with no limiter of its own.
            const claimed = await claimAttempt(db, { accountId: player });
            if (!(await verifyPassword(claimed?.hash, current))) {
                return { outcome: 'wrong_password' };
            }
            await clearAttempts(db, player);

            try {
                await db.account.delete({ where: { id: player } });
                return { outcome: 'closed' };
            } catch (error) {
                // Games are Restrict, so this is an owner still holding one. Their bundles and
                // leaderboard rows live in S3 and DynamoDB, where no cascade here would reach them.
                if (codeOf(error) === FOREIGN_KEY_VIOLATION) return { outcome: 'owns_games' };
                throw error;
            }
        },

        beginPasswordReset: async (email) => {
            const account = await db.account.findUnique({
                where: { email: foldEmail(email) },
                select: { id: true, email: true },
            });
            if (account === null) return { outcome: 'no_account' };

            const token = mintToken();
            await db.$transaction([
                // The account's earlier keys go first, spent or not: the partial unique index allows
                // one live row, and a mailbox holding ten old links should not hold ten open doors.
                db.passwordReset.deleteMany({ where: { accountId: account.id } }),
                db.passwordReset.create({
                    data: {
                        accountId: account.id,
                        tokenHash: digest(token),
                        expiresAt: new Date(Date.now() + RESET_TTL_MS),
                    },
                }),
            ]);
            return { outcome: 'begun', email: account.email, token };
        },

        finishPasswordReset: async (token, next) => {
            // Spent in the same statement that finds it, so two clicks on one link cannot both land
            // — a read, then a write, is a race with a network round trip inside it.
            const spent = await db.passwordReset.updateMany({
                where: {
                    tokenHash: digest(token),
                    consumedAt: null,
                    expiresAt: { gt: new Date() },
                },
                data: { consumedAt: new Date() },
            });
            if (spent.count === 0) return { outcome: 'refused' };

            const row = await db.passwordReset.findUnique({
                where: { tokenHash: digest(token) },
                select: { accountId: true },
            });
            if (row === null) return { outcome: 'refused' };

            await db.passwordCredential.update({
                where: { accountId: row.accountId },
                // Clearing the count matters as much as the hash: somebody resetting a password has
                // usually just locked themselves out guessing at the old one, and a reset that left
                // them locked would be no way back in.
                data: {
                    hash: await hashPassword(next),
                    failedAttempts: 0,
                    lastFailedAt: null,
                    lockedUntil: null,
                },
            });
            return { outcome: 'reset', player: PlayerId.parse(row.accountId) };
        },

        createGame: async (owner, title) => {
            const game = await db.game.create({ data: { ownerId: owner, title } });
            return { outcome: 'created', game: asGame(game) };
        },

        gamesOf: async (owner) => {
            const rows = await db.game.findMany({
                where: { ownerId: owner },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 100,
            });
            return rows.map(asGame);
        },

        gameOf: async (game) => {
            const row = await db.game.findUnique({ where: { id: game } });
            return row === null ? undefined : asGame(row);
        },

        setVisibility: async (game, visibility) => {
            try {
                const row = await db.game.update({ where: { id: game }, data: { visibility } });
                return { outcome: 'updated', game: asGame(row) };
            } catch (error) {
                if (codeOf(error) === RECORD_NOT_FOUND) return { outcome: 'missing' };
                throw error;
            }
        },

        workspaceOf: async (game) => {
            const row = await db.game.findUnique({
                where: { id: game },
                select: WORKSPACE_SELECT,
            });
            return row === null ? undefined : asWorkspace(row);
        },

        fileOf: async (game, path) => {
            const row = await db.gameFile.findUnique({
                where: { gameId_path: { gameId: game, path } },
                select: {
                    path: true,
                    kind: true,
                    versionId: true,
                    byteLength: true,
                    contentType: true,
                },
            });
            return row === null ? undefined : asFile(row);
        },

        saveWorkspace: async (game, plan) => {
            return db
                .$transaction(async (tx): Promise<WorkspaceSaved> => {
                    // The revision is claimed in the statement that checks it, so two editors
                    // holding one base cannot both write: the second matches no row and is stale.
                    const claimed = await tx.game.updateMany({
                        where: { id: game, draftRevision: plan.baseRevision },
                        data: { draftRevision: plan.baseRevision + 1 },
                    });

                    if (claimed.count === 0) {
                        const current = await tx.game.findUnique({
                            where: { id: game },
                            select: WORKSPACE_SELECT,
                        });
                        return current === null
                            ? { outcome: 'missing' }
                            : { outcome: 'stale', workspace: asWorkspace(current) };
                    }
                    const revision = plan.baseRevision + 1;

                    // A save is a delta, so the rows are reconciled rather than replaced: a path
                    // this request never mentions is one the creator did not touch.
                    if (plan.deletes.length > 0) {
                        await tx.gameFile.deleteMany({
                            where: { gameId: game, path: { in: plan.deletes } },
                        });
                    }
                    for (const file of plan.upserts) {
                        // One statement per path rather than a createMany: an upsert is what makes
                        // re-saving a file a new version of it instead of a duplicate key.
                        // oxlint-disable-next-line no-await-in-loop
                        await tx.gameFile.upsert({
                            where: { gameId_path: { gameId: game, path: file.path } },
                            create: { gameId: game, ...file },
                            update: {
                                kind: file.kind,
                                versionId: file.versionId,
                                byteLength: file.byteLength,
                                contentType: file.contentType,
                            },
                        });
                    }

                    // One task per asset this save introduced, pinned to the revision it landed in.
                    // A save of nothing but source creates none, so the typing loop costs nothing.
                    const tasks: Task[] = [];
                    for (const asset of plan.upserts.filter((file) => file.kind === 'asset')) {
                        // oxlint-disable-next-line no-await-in-loop
                        const row = await tx.task.create({
                            data: {
                                gameId: game,
                                accountId: plan.accountId,
                                kind: 'ASSET_UPLOAD',
                                manifestRevision: revision,
                                assetPath: asset.path,
                            },
                        });
                        tasks.push(asTask(row));
                    }

                    const saved = await tx.game.findUniqueOrThrow({
                        where: { id: game },
                        select: WORKSPACE_SELECT,
                    });
                    const workspace = asWorkspace(saved);

                    // Inside the transaction on purpose: the revision and the manifest naming it are
                    // one fact, and a manifest the bucket refused has to leave no revision behind
                    // for a rollback to point at. It is one small write, and it is the last thing
                    // this transaction waits on.
                    if (!(await plan.freeze(revision, workspace.files)))
                        throw new ManifestRefused();
                    return { outcome: 'saved', workspace, tasks };
                })
                .catch((error: unknown) => {
                    if (error instanceof ManifestRefused) return { outcome: 'unfrozen' as const };
                    throw error;
                });
        },

        publishedVersionOf: async (game) => {
            const row = await db.game.findUnique({
                where: { id: game },
                select: { publishedRevision: true, publishedAt: true },
            });
            // Two columns, one fact: a migration CHECK keeps them null or set together, so reading
            // one is reading both.
            if (row === null || row.publishedRevision === null || row.publishedAt === null) {
                return undefined;
            }
            return {
                revision: row.publishedRevision,
                publishedAt: row.publishedAt.toISOString(),
            };
        },

        playableVersionOf: async (game) => {
            // Ordered by the revision and not by the date a box happened to finish: what makes one
            // version newer than another is the manifest it compiled.
            const row = await db.task.findFirst({
                where: { gameId: game, kind: 'BUILD', status: 'SUCCESSFUL' },
                orderBy: { manifestRevision: 'desc' },
                select: { manifestRevision: true, detail: true },
            });
            if (row === null) return undefined;

            // A build settled without one is a worker that answered outside its own contract, and
            // sending a player at a version naming no code would fail on the box instead of here.
            const bundles = BundleSet.safeParse(
                (row.detail as { bundles?: unknown } | null)?.bundles,
            );
            if (!bundles.success) return undefined;
            return { revision: row.manifestRevision, bundles: bundles.data };
        },

        markPublished: async (game, version) => {
            await db.game.update({
                where: { id: game },
                data: {
                    publishedRevision: version.revision,
                    publishedAt: new Date(version.publishedAt),
                },
            });
        },

        queueTask: async (game, account, kind, manifestRevision) => {
            const live = await db.task.findFirst({
                where: { gameId: game, kind, manifestRevision, status: { in: [...LIVE] } },
            });
            if (live !== null) return { outcome: 'existing', task: asTask(live) };

            try {
                const row = await db.task.create({
                    data: { gameId: game, accountId: account, kind, manifestRevision },
                });
                return { outcome: 'queued', task: asTask(row) };
            } catch (error) {
                // Two publishes landing together: the index refused the second, and what the caller
                // wants is the row that won rather than a failure.
                if (codeOf(error) === UNIQUE_VIOLATION) {
                    const won = await db.task.findFirst({
                        where: { gameId: game, kind, manifestRevision, status: { in: [...LIVE] } },
                    });
                    if (won !== null) return { outcome: 'existing', task: asTask(won) };
                }
                // A game or an account that is gone, which is a task nothing could ever settle.
                if (codeOf(error) === FOREIGN_KEY_VIOLATION) return { outcome: 'missing' };
                throw error;
            }
        },

        taskOf: async (game, task) => {
            const row = await db.task.findFirst({ where: { id: task, gameId: game } });
            return row === null ? undefined : asTask(row);
        },

        advanceTask: async (task, update) => {
            const current = await db.task.findUnique({ where: { id: task } });
            if (current === null) return { outcome: 'missing' };
            // A redelivered attempt must not walk a settled task back, which is the one rule the
            // status route exists to hold: an outcome is written once.
            if (isTerminal(current.status)) return { outcome: 'backwards', task: asTask(current) };

            const now = new Date();
            const moved = await db.task.updateMany({
                // The guard, not the read above, is what makes this safe: two workers claiming at
                // once leave one of them matching no row.
                where: { id: task, status: { in: [...LIVE] } },
                data: {
                    status: update.status,
                    ...(update.detail === undefined ? {} : { detail: update.detail }),
                    // Counted on every claim, so a task redelivered after a worker died says how
                    // many boxes have tried it.
                    ...(update.status === 'IN_PROGRESS'
                        ? { attempts: { increment: 1 }, startedAt: now }
                        : {}),
                    // A task settled without ever being claimed still needs a start: a finish with
                    // no start is a lifecycle the CHECK refuses and a sweeper cannot reason about.
                    ...(isTerminal(update.status)
                        ? { finishedAt: now, startedAt: current.startedAt ?? now }
                        : {}),
                },
            });

            const settled = await db.task.findUniqueOrThrow({ where: { id: task } });
            return moved.count === 0
                ? { outcome: 'backwards', task: asTask(settled) }
                : { outcome: 'advanced', task: asTask(settled) };
        },

        unclaimedTasks: async (kind, before, limit) => {
            const rows = await db.task.findMany({
                where: { kind, status: 'NOT_STARTED', createdAt: { lt: before } },
                orderBy: { createdAt: 'asc' },
                take: limit,
            });
            return rows.map(asTask);
        },

        recordFleet: async (report) => {
            const hosts = report.hosts.map((host) => {
                const row = {
                    region: host.region,
                    liveness: host.liveness,
                    incarnation: host.incarnation,
                    runningInstances: host.capacity.runningInstances,
                    maxInstances: host.capacity.maxInstances,
                    cpuLoad: host.capacity.cpuLoad,
                    memoryFreeBytes: BigInt(host.capacity.memoryFreeBytes),
                    lastSeenAt: new Date(host.lastSeenAt),
                };
                // Upsert rather than insert: a box is named by the fleet it beat into, so the same
                // id comes back every report for as long as that box lives.
                return db.fleetHost.upsert({
                    where: { id: host.hostId },
                    create: { id: host.hostId, ...row },
                    update: row,
                });
            });

            // One transaction, because a snapshot its own events contradict is a fleet nobody can
            // read back: the row would say healthy while the history's last word was `failed`.
            await db.$transaction([
                ...hosts,
                db.fleetHostEvent.createMany({
                    data: report.events.map((event) => ({
                        id: event.eventId,
                        hostId: event.hostId,
                        region: event.region,
                        kind: event.kind,
                        incarnation: event.incarnation,
                        at: new Date(event.at),
                        detail: event.detail ?? null,
                    })),
                    // The id is the router's, so a report retried after a failed write lands on the
                    // rows it already wrote rather than a second copy of them.
                    skipDuplicates: true,
                }),
            ]);
        },
    };
}

/** Doubling to a ceiling rather than locking outright: the name is an address anyone can aim at. */
const LOCK_AFTER = 5;
const LOCK_CEILING = '15 minutes';
/** Failures this old are somebody mistyping last week, not the burst the lock is aimed at. */
const DECAY = LOCK_CEILING;
/** 2^20 seconds is past the ceiling many times over, and keeps `power` away from infinity. */
const MAX_DOUBLINGS = 20;

interface Claimed {
    accountId: string;
    hash: string;
}

/**
 * Spends one attempt against a password, and hands back the hash to check only if there was one to
 * spend.
 *
 * One statement, and the count happens BEFORE the verify rather than after it. Read-then-verify-then
 * -write leaves a window as wide as argon2 takes — tens of milliseconds under load — in which every
 * request in a burst reads the same unlocked row and every guess gets checked; `FOR UPDATE` makes
 * the attempts queue, and Postgres re-checks the lock predicate against the row each one finds.
 *
 * The count decays, which is what stops a lockout from being something an attacker holds open
 * forever: without it one wrong guess per ceiling, from one address, keeps a person out for good.
 */
async function claimAttempt(
    db: PrismaClient,
    by: { email: string } | { accountId: string },
): Promise<Claimed | undefined> {
    const email = 'email' in by ? by.email : null;
    const accountId = 'accountId' in by ? by.accountId : null;

    const claimed = await db.$queryRaw<Claimed[]>`
        WITH target AS (
            SELECT c."accountId",
                   CASE
                       WHEN c."lastFailedAt" IS NULL
                         OR c."lastFailedAt" < now() - ${DECAY}::interval THEN 1
                       ELSE c."failedAttempts" + 1
                   END AS next
              FROM "PasswordCredential" c
              JOIN "Account" a ON a."id" = c."accountId"
             WHERE (${email}::text IS NULL OR a."email" = ${email}::text)
               AND (${accountId}::uuid IS NULL OR c."accountId" = ${accountId}::uuid)
               AND (c."lockedUntil" IS NULL OR c."lockedUntil" <= now())
               FOR UPDATE OF c
        )
        UPDATE "PasswordCredential" c
           SET "failedAttempts" = t.next,
               "lastFailedAt" = now(),
               "lockedUntil" = CASE
                   WHEN t.next >= ${LOCK_AFTER} THEN now() + LEAST(
                       interval '1 second' * power(2, LEAST(t.next - ${LOCK_AFTER}, ${MAX_DOUBLINGS})),
                       ${LOCK_CEILING}::interval)
                   ELSE NULL
               END
          FROM target t
         WHERE c."accountId" = t."accountId"
     RETURNING c."accountId", c."hash"
    `;
    return claimed[0];
}

/** Hands back the attempts a right password just earned. Unconditional, because the count it would
 * otherwise be compared against was read before the verify and may have moved since. */
async function clearAttempts(db: PrismaClient, accountId: string): Promise<void> {
    await db.passwordCredential.updateMany({
        where: { accountId },
        data: { failedAttempts: 0, lastFailedAt: null, lockedUntil: null },
    });
}

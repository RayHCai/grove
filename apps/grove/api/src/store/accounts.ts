import { randomBytes } from 'node:crypto';
import { PlayerId } from '@grove/api-contract';
import { hashPassword, verifyPassword } from '../passwords.js';
import type { AccountRecord, Accounts, ResetBegun } from '../records.js';
import { foldEmail } from '../values.js';
import type { Account, PrismaClient } from '../generated/prisma/client.js';
import {
    FOREIGN_KEY_VIOLATION,
    RECORD_NOT_FOUND,
    UNIQUE_VIOLATION,
    codeOf,
    digest,
} from './shared.js';

/** Long enough that the mail sits in an inbox, short enough that a forwarded one goes stale. */
const RESET_TTL_MS = 60 * 60 * 1000;

/** How many reset mails one address is sent per window, so the form cannot flood an inbox. */
const RESET_MAILS_PER_WINDOW = 3;
const RESET_MAIL_WINDOW_MS = 60 * 60 * 1000;

/** 256 bits, so the digest the row keeps is the only thing between a guess and an account. */
function mintToken(): string {
    return randomBytes(32).toString('base64url');
}

type AccountRow = Account & { password: { accountId: string } | null };

function asAccount(row: AccountRow): AccountRecord {
    return {
        playerId: PlayerId.parse(row.id),
        email: row.email,
        displayName: row.displayName,
        createdAt: row.createdAt.toISOString(),
    };
}

const WITH_PASSWORD = { password: { select: { accountId: true } } };

/** The accounts tables, every failure an outcome: a Prisma message names a constraint verbatim. */
export function prismaAccounts(db: PrismaClient): Accounts {
    return {
        signIn: async (email, password) => {
            // Folded on the way in as well as out, or an address stored lowercase is unreachable.
            const claimed = await claimAttempt(db, { email: foldEmail(email) });
            // Verified before the branch, so no answer is reached without paying argon2 for it.
            const matched = await verifyPassword(claimed?.hash, password);
            if (claimed === undefined || !matched) return undefined;

            await clearAttempts(db, claimed.accountId);
            return PlayerId.parse(claimed.accountId);
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
                    // Only "no such row" is an answer; anything else is the database failing.
                    if (codeOf(error) === RECORD_NOT_FOUND) return null;
                    throw error;
                });
            return row === null
                ? { outcome: 'missing' }
                : { outcome: 'renamed', account: asAccount(row) };
        },

        changePassword: async (player, current, next) => {
            // Through the claim a sign-in spends, so whoever rides a session guesses no faster.
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
            const claimed = await claimAttempt(db, { accountId: player });
            if (!(await verifyPassword(claimed?.hash, current))) {
                return { outcome: 'wrong_password' };
            }
            await clearAttempts(db, player);

            try {
                await db.account.delete({ where: { id: player } });
                return { outcome: 'closed' };
            } catch (error) {
                // Games are Restrict: their bundles and rows live where no cascade here reaches.
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
            const now = Date.now();
            const windowStart = new Date(now - RESET_MAIL_WINDOW_MS);
            try {
                return await db.$transaction(async (tx): Promise<ResetBegun> => {
                    const recent = await tx.passwordReset.count({
                        where: { accountId: account.id, createdAt: { gt: windowStart } },
                    });
                    if (recent >= RESET_MAILS_PER_WINDOW) return { outcome: 'throttled' };

                    // Only rows past the window count for nothing, so they alone are dropped.
                    await tx.passwordReset.deleteMany({
                        where: { accountId: account.id, createdAt: { lte: windowStart } },
                    });
                    // Superseded rather than deleted, so the count above still sees this mail.
                    await tx.passwordReset.updateMany({
                        where: { accountId: account.id, consumedAt: null },
                        data: { consumedAt: new Date(now) },
                    });
                    await tx.passwordReset.create({
                        data: {
                            accountId: account.id,
                            tokenHash: digest(token),
                            expiresAt: new Date(now + RESET_TTL_MS),
                        },
                    });
                    return { outcome: 'begun', email: account.email, token };
                });
            } catch (error) {
                // Two asks at once: the index keeps one live key, and the loser sends nothing.
                if (codeOf(error) === UNIQUE_VIOLATION) return { outcome: 'throttled' };
                throw error;
            }
        },

        finishPasswordReset: async (token, next) => {
            // Spent in the statement that finds it, so two clicks on one link cannot both land.
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
                // Cleared with the hash: whoever resets has usually locked themselves out.
                data: {
                    hash: await hashPassword(next),
                    failedAttempts: 0,
                    lastFailedAt: null,
                    lockedUntil: null,
                },
            });
            return { outcome: 'reset', player: PlayerId.parse(row.accountId) };
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

// One attempt is spent before the verify, in one `FOR UPDATE` statement, so a burst queues;
// the count decays at the ceiling, so one guess per window cannot hold somebody out for good.
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

/** Unconditional, because the count it would be compared against may have moved since. */
async function clearAttempts(db: PrismaClient, accountId: string): Promise<void> {
    await db.passwordCredential.updateMany({
        where: { accountId },
        data: { failedAttempts: 0, lastFailedAt: null, lockedUntil: null },
    });
}

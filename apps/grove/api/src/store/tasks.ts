import {
    BuildManifest,
    GameId,
    TaskId,
    VersionId,
    WorkspacePath,
    isTerminal,
    type BuildArtifact,
} from '@grove/api-contract';
import type { BuildQueued, TaskSettled, Tasks } from '../records.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FOREIGN_KEY_VIOLATION, LIVE, UNIQUE_VIOLATION, asTask, codeOf } from './shared.js';

/** How many unverified assets a refusal names before the list stops being something to read. */
const NAMED_ASSETS = 10;

/** The one live build a revision may have, which a unique index also holds the table to. */
function liveBuild(game: string, revision: number) {
    return {
        gameId: game,
        kind: 'BUILD' as const,
        manifestRevision: revision,
        status: { in: [...LIVE] },
    };
}

/** The task tables: one row per piece of queued work, the lease on it, and what a build stored. */
export function prismaTasks(db: PrismaClient): Tasks {
    return {
        queueBuild: async (game, account, revision, saveId) => {
            let queued: BuildQueued;
            try {
                queued = await db.$transaction(async (tx): Promise<BuildQueued> => {
                    // Locked, so no save lands between the verdicts read here and the build pinned.
                    const [held] = await tx.$queryRaw<
                        { draftRevision: number; draftSaveId: string | null }[]
                    >`SELECT "draftRevision", "draftSaveId" FROM "Game" WHERE "id" = ${game}::uuid FOR UPDATE`;
                    if (held === undefined) return { outcome: 'missing' };
                    if (
                        held.draftRevision !== revision ||
                        (held.draftSaveId ?? undefined) !== saveId
                    ) {
                        return { outcome: 'moved' };
                    }

                    // Raw, because the question is whether two columns of one row agree.
                    const unverified = await tx.$queryRaw<{ path: string }[]>`
                        SELECT "path"
                          FROM "GameFile"
                         WHERE "gameId" = ${game}::uuid
                           AND "kind" = 'asset'
                           AND ("validatedVersionId" IS NULL OR "validatedVersionId" <> "versionId")
                         ORDER BY "path"
                         LIMIT ${NAMED_ASSETS}
                    `;
                    if (unverified.length > 0) {
                        return {
                            outcome: 'unverified',
                            paths: unverified.map((row) => WorkspacePath.parse(row.path)),
                        };
                    }

                    const live = await tx.task.findFirst({ where: liveBuild(game, revision) });
                    if (live !== null) return { outcome: 'existing', task: asTask(live) };

                    const row = await tx.task.create({
                        data: {
                            gameId: game,
                            accountId: account,
                            kind: 'BUILD',
                            manifestRevision: revision,
                            manifestSaveId: saveId ?? null,
                        },
                    });
                    return { outcome: 'queued', task: asTask(row) };
                });
            } catch (error) {
                // Two publishes at once: the index refused the second, which wants the first.
                if (codeOf(error) === UNIQUE_VIOLATION) {
                    const won = await db.task.findFirst({ where: liveBuild(game, revision) });
                    if (won !== null) return { outcome: 'existing', task: asTask(won) };
                }
                if (codeOf(error) === FOREIGN_KEY_VIOLATION) return { outcome: 'missing' };
                throw error;
            }
            return queued;
        },

        taskOf: async (game, task) => {
            const row = await db.task.findFirst({ where: { id: task, gameId: game } });
            return row === null ? undefined : asTask(row);
        },

        claimTask: async (task, { kind, worker, leaseMs }) => {
            const now = new Date();
            const leaseUntil = new Date(now.getTime() + leaseMs);
            // The guard is the claim: a live lease matches nothing, so a duplicate counts nothing.
            const [claimed] = await db.task.updateManyAndReturn({
                where: {
                    id: task,
                    kind,
                    OR: [
                        { status: 'NOT_STARTED' },
                        { status: 'IN_PROGRESS', leaseUntil: { lte: now } },
                    ],
                },
                data: {
                    status: 'IN_PROGRESS',
                    attempts: { increment: 1 },
                    startedAt: now,
                    claimedBy: worker,
                    leaseUntil,
                },
            });
            if (claimed !== undefined)
                return { outcome: 'claimed', task: asTask(claimed), leaseUntil };

            const row = await db.task.findUnique({ where: { id: task } });
            if (row === null || row.kind !== kind) return { outcome: 'missing' };
            if (isTerminal(row.status)) return { outcome: 'settled', task: asTask(row) };
            return { outcome: 'held', task: asTask(row), leaseUntil: row.leaseUntil ?? leaseUntil };
        },

        uploadOf: async (task) => {
            const row = await db.task.findUnique({
                where: { id: task },
                select: { kind: true, gameId: true, assetPath: true, assetVersionId: true },
            });
            if (row === null || row.kind !== 'ASSET_UPLOAD') return undefined;
            if (row.assetPath === null || row.assetVersionId === null) return undefined;
            // By version: an upload a later save replaced is one the game no longer holds.
            const file = await db.gameFile.findFirst({
                where: {
                    gameId: row.gameId,
                    path: row.assetPath,
                    kind: 'asset',
                    versionId: row.assetVersionId,
                },
                select: { byteLength: true, contentType: true },
            });
            if (file === null) return undefined;
            return {
                gameId: GameId.parse(row.gameId),
                path: WorkspacePath.parse(row.assetPath),
                versionId: VersionId.parse(row.assetVersionId),
                byteLength: file.byteLength,
                contentType: file.contentType,
            };
        },

        settleTask: async (task, kind, update, { holder, edgeVersionId } = {}) => {
            const current = await db.task.findUnique({ where: { id: task } });
            if (current === null || current.kind !== kind) return { outcome: 'missing' };
            if (isTerminal(current.status)) return { outcome: 'refused', task: asTask(current) };

            const now = new Date();
            const startedAt = current.startedAt ?? now;
            // Never before the start, whichever replica's clock wrote it.
            const finishedAt = new Date(Math.max(now.getTime(), startedAt.getTime()));
            return db.$transaction(async (tx): Promise<TaskSettled> => {
                // A holder settles only the claim it holds, so a worker whose lease lapsed and was
                // taken over cannot overwrite the outcome of the worker that took it.
                const moved = await tx.task.updateMany({
                    where:
                        holder === undefined
                            ? { id: task, kind, status: { in: [...LIVE] } }
                            : { id: task, kind, status: 'IN_PROGRESS', claimedBy: holder },
                    data: {
                        status: update.status,
                        ...(update.detail === undefined ? {} : { detail: update.detail }),
                        startedAt,
                        finishedAt,
                    },
                });
                const settled = await tx.task.findUniqueOrThrow({ where: { id: task } });
                if (moved.count === 0) return { outcome: 'refused', task: asTask(settled) };

                // By version, so a save that replaced the bytes leaves the row unvalidated.
                let validated = false;
                if (
                    settled.status === 'SUCCESSFUL' &&
                    settled.assetPath !== null &&
                    settled.assetVersionId !== null &&
                    edgeVersionId !== undefined
                ) {
                    const marked = await tx.gameFile.updateMany({
                        where: {
                            gameId: settled.gameId,
                            path: settled.assetPath,
                            kind: 'asset',
                            versionId: settled.assetVersionId,
                        },
                        data: { validatedVersionId: settled.assetVersionId, edgeVersionId },
                    });
                    validated = marked.count === 1;
                }
                return { outcome: 'settled', task: asTask(settled), validated };
            });
        },

        buildOf: async (task) => {
            const row = await db.task.findUnique({
                where: { id: task },
                select: {
                    id: true,
                    gameId: true,
                    kind: true,
                    status: true,
                    manifestRevision: true,
                    manifestSaveId: true,
                },
            });
            if (row === null || row.kind !== 'BUILD') return undefined;
            return {
                taskId: TaskId.parse(row.id),
                gameId: GameId.parse(row.gameId),
                revision: row.manifestRevision,
                saveId: row.manifestSaveId ?? undefined,
                live: row.status === 'IN_PROGRESS',
            };
        },

        recordArtifact: async (task, artifact) => {
            // Content-addressed, so storing one twice is storing the same bytes twice.
            await db.buildArtifact.createMany({
                data: [{ taskId: task, ...artifact }],
                skipDuplicates: true,
            });
        },

        artifactsOf: async (task) => {
            const rows = await db.buildArtifact.findMany({
                where: { taskId: task },
                select: { name: true, url: true, hash: true, byteLength: true },
            });
            return rows as BuildArtifact[];
        },

        playableVersionOf: async (game) => {
            // By revision, because what makes a version newer is the manifest it compiled.
            const row = await db.task.findFirst({
                where: { gameId: game, kind: 'BUILD', status: 'SUCCESSFUL' },
                orderBy: [{ manifestRevision: 'desc' }, { finishedAt: 'desc' }],
                select: { manifestRevision: true, detail: true },
            });
            if (row === null) return undefined;

            const built = BuildManifest.safeParse(
                (row.detail as { build?: unknown } | null)?.build,
            );
            // A manifest naming another revision or game is a worker that settled the wrong task.
            if (!built.success) return undefined;
            if (built.data.revision !== row.manifestRevision || built.data.gameId !== game) {
                return undefined;
            }
            const { gameId: _gameId, ...version } = built.data;
            return version;
        },

        claimAnnouncements: async (kind, before, now, limit) => {
            // Stamped in the statement that picks them, with SKIP LOCKED, so two replicas sweeping
            // at once split the backlog instead of each announcing all of it.
            const rows = await db.$queryRaw<{ id: string }[]>`
                UPDATE "Task"
                   SET "announcedAt" = ${now}::timestamptz,
                       "updatedAt" = ${now}::timestamptz
                 WHERE "id" IN (
                       SELECT "id"
                         FROM "Task"
                        WHERE "kind" = ${kind}::"TaskKind"
                          AND "announcedAt" < ${before}::timestamptz
                          AND ("status" = 'NOT_STARTED'
                               OR ("status" = 'IN_PROGRESS' AND "leaseUntil" <= ${now}::timestamptz))
                        ORDER BY "announcedAt"
                        LIMIT ${limit}
                          FOR UPDATE SKIP LOCKED)
             RETURNING "id"
            `;
            return rows.map((row) => TaskId.parse(row.id));
        },

        markAnnounced: async (tasks, at) => {
            if (tasks.length === 0) return;
            await db.task.updateMany({
                where: { id: { in: [...tasks] } },
                data: { announcedAt: at },
            });
        },

        reapAbandoned: async (kind, before, message) => {
            const now = new Date();
            const detail = JSON.stringify({ message });
            const reaped = await db.$queryRaw<{ id: string }[]>`
                UPDATE "Task"
                   SET "status" = 'FAILED',
                       "detail" = ${detail}::jsonb,
                       "finishedAt" = GREATEST(${now}::timestamptz, "startedAt"),
                       "updatedAt" = ${now}::timestamptz
                 WHERE "status" = 'IN_PROGRESS'
                   AND "kind" = ${kind}::"TaskKind"
                   AND "leaseUntil" < ${before}::timestamptz
             RETURNING "id"
            `;
            return reaped.map((row) => TaskId.parse(row.id));
        },
    };
}

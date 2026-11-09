import { VersionId, encodeManifest, type Task, type WorkspaceFile } from '@grove/api-contract';
import type { WorkspaceSaved, Workspaces } from '../records.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FILE_SELECT, WORKSPACE_SELECT, asFile, asTask, asWorkspace } from './shared.js';

/** Room for a save of every file a game may hold; no bucket call is made inside one. */
const SAVE_TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;

/** Thrown to roll a save back when the rows it reached are not the set its manifest froze. */
class Drifted extends Error {}

/** The workspace tables: one row per path, and the revision a save claims for the set. */
export function prismaWorkspaces(db: PrismaClient): Workspaces {
    const current = async (game: string): Promise<WorkspaceSaved> => {
        const row = await db.game.findUnique({ where: { id: game }, select: WORKSPACE_SELECT });
        return row === null
            ? { outcome: 'missing' }
            : { outcome: 'stale', workspace: asWorkspace(row) };
    };

    return {
        workspaceOf: async (game) => {
            const row = await db.game.findUnique({ where: { id: game }, select: WORKSPACE_SELECT });
            return row === null ? undefined : asWorkspace(row);
        },

        fileOf: async (game, path) => {
            const row = await db.gameFile.findUnique({
                where: { gameId_path: { gameId: game, path } },
                select: { ...FILE_SELECT, validatedVersionId: true, edgeVersionId: true },
            });
            if (row === null) return undefined;
            // The edge copy answers only while the verdict names the bytes the row holds.
            const inspected =
                row.validatedVersionId === row.versionId && row.edgeVersionId !== null;
            return {
                ...asFile(row),
                edgeVersionId: inspected ? VersionId.parse(row.edgeVersionId) : undefined,
            };
        },

        saveWorkspace: async (game, plan) => {
            const saved = await db
                .$transaction(async (tx): Promise<WorkspaceSaved | undefined> => {
                    // Claimed in the statement that checks it, so one of two saves on a base lands.
                    const claimed = await tx.game.updateMany({
                        where: { id: game, draftRevision: plan.baseRevision },
                        data: { draftRevision: plan.baseRevision + 1, draftSaveId: plan.saveId },
                    });
                    if (claimed.count === 0) return undefined;
                    const revision = plan.baseRevision + 1;
                    const now = new Date();

                    const touched = [...plan.deletes, ...plan.upserts.map((file) => file.path)];
                    if (touched.length > 0) {
                        // An inspection of bytes this save replaces or removes vouches for nothing.
                        await tx.$executeRaw`
                            UPDATE "Task"
                               SET "status" = 'CANCELLED',
                                   "startedAt" = COALESCE("startedAt", ${now}::timestamptz),
                                   "finishedAt" = GREATEST(${now}::timestamptz, "startedAt"),
                                   "updatedAt" = ${now}::timestamptz
                             WHERE "gameId" = ${game}::uuid
                               AND "kind" = 'ASSET_UPLOAD'
                               AND "status" IN ('NOT_STARTED', 'IN_PROGRESS')
                               AND "assetPath" = ANY(${touched}::text[])
                        `;
                        // Replaced as rows rather than updated, which also drops the old verdict.
                        await tx.gameFile.deleteMany({
                            where: { gameId: game, path: { in: touched } },
                        });
                    }
                    if (plan.upserts.length > 0) {
                        await tx.gameFile.createMany({
                            data: plan.upserts.map((file) => ({ gameId: game, ...file })),
                        });
                    }

                    const assets = plan.upserts.filter((file) => file.kind === 'asset');
                    const created = await tx.task.createManyAndReturn({
                        data: assets.map((asset) => ({
                            gameId: game,
                            accountId: plan.accountId,
                            kind: 'ASSET_UPLOAD' as const,
                            manifestRevision: revision,
                            assetPath: asset.path,
                            assetVersionId: asset.versionId,
                        })),
                    });
                    // In the order the save named them, which RETURNING does not promise.
                    const order = new Map(assets.map((asset, at) => [asset.path as string, at]));
                    const tasks: Task[] = created
                        .toSorted(
                            (left, right) =>
                                (order.get(left.assetPath ?? '') ?? 0) -
                                (order.get(right.assetPath ?? '') ?? 0),
                        )
                        .map(asTask);

                    const row = await tx.game.findUniqueOrThrow({
                        where: { id: game },
                        select: WORKSPACE_SELECT,
                    });
                    const workspace = asWorkspace(row);
                    if (!sameSet(game, revision, workspace.files, plan.frozen)) throw new Drifted();
                    return { outcome: 'saved', workspace, tasks };
                }, SAVE_TRANSACTION)
                .catch((error: unknown) => {
                    if (error instanceof Drifted) return undefined;
                    throw error;
                });
            return saved ?? current(game);
        },
    };
}

function sameSet(
    game: string,
    revision: number,
    held: readonly WorkspaceFile[],
    frozen: readonly WorkspaceFile[],
): boolean {
    const encode = (files: readonly WorkspaceFile[]) =>
        encodeManifest({ gameId: game as never, revision, files: [...files] });
    return encode(held) === encode(frozen);
}

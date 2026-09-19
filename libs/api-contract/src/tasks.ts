import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { GameId, TaskId } from './ids.js';
import { WorkspacePath } from './workspace.js';

/**
 * What kind of queued work a task is.
 *
 * One shape for both, because a build and an asset upload have the same life: claimed, attempted,
 * settled, swept. Two shapes would mean two sweepers and two sets of transition rules.
 */
export const TaskKind = z.enum(['BUILD', 'ASSET_UPLOAD']);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum([
    'NOT_STARTED',
    'IN_PROGRESS',
    'SUCCESSFUL',
    'FAILED',
    'CANCELLED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Nothing moves out of one of these, which is what makes a redelivered attempt harmless. */
export function isTerminal(status: TaskStatus): boolean {
    return status === 'SUCCESSFUL' || status === 'FAILED' || status === 'CANCELLED';
}

/** One compiler complaint, positioned the way a creator's editor gutters it. */
export const BuildDiagnostic = z.object({
    severity: z.enum(['error', 'warning']),
    file: z.string(),
    line: z.int().positive(),
    column: z.int().positive(),
    message: z.string(),
});
export type BuildDiagnostic = z.infer<typeof BuildDiagnostic>;

/**
 * What a worker has to say about the task it settled.
 *
 * Every member is optional because one shape covers both kinds: a build reports diagnostics and the
 * bundle set it registered, and an upload reports the bytes it saw.
 */
export const TaskDetail = z.object({
    /** A clean build may still carry warnings, so this is present on a success too. */
    diagnostics: z.array(BuildDiagnostic).optional(),
    /** Present only on a build that succeeded — nothing else registers a bundle set. */
    bundles: BundleSet.optional(),
    fileCount: z.int().nonnegative().optional(),
    byteLength: z.int().nonnegative().optional(),
    /** A failure of the fleet rather than of the source, in words a creator can read. */
    message: z.string().max(1024).optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/**
 * One piece of queued work, as the creator who asked for it and the worker that claimed it see it.
 *
 * `manifestRevision` is what every kind is pinned to: a build compiles that snapshot however much
 * the editor has typed since, and an asset upload is settled against the save that landed it.
 */
export const Task = z
    .object({
        taskId: TaskId,
        gameId: GameId,
        kind: TaskKind,
        status: TaskStatus,
        manifestRevision: z.int().positive(),
        /** The asset this is for; absent for every kind but `ASSET_UPLOAD`. */
        assetPath: WorkspacePath.optional(),
        attempts: z.int().nonnegative(),
        detail: TaskDetail.optional(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        startedAt: z.iso.datetime().optional(),
        finishedAt: z.iso.datetime().optional(),
    })
    .refine((task) => (task.assetPath === undefined) === (task.kind !== 'ASSET_UPLOAD'), {
        error: 'only an asset upload names an asset, and it always does',
    });
export type Task = z.infer<typeof Task>;

/**
 * What a worker writes back as it claims and settles a task.
 *
 * `NOT_STARTED` is deliberately absent: a task only ever leaves that state, and a redelivery that
 * could put one back would make the sweeper re-push work already in flight.
 */
export const TaskStatusUpdate = z.object({
    status: z.enum(['IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'CANCELLED']),
    detail: TaskDetail.optional(),
});
export type TaskStatusUpdate = z.infer<typeof TaskStatusUpdate>;

/**
 * The message a stream carries, which is a task id and nothing else.
 *
 * The row is written before this is pushed, so a worker reads the task from the database rather
 * than from the message — and a push that was lost is a row a sweeper can still find.
 */
export const TaskMessage = z.object({ taskId: TaskId });
export type TaskMessage = z.infer<typeof TaskMessage>;

/** One stream per kind: two services read these, and one stream would make each skip the other's. */
export function streamOf(kind: TaskKind): string {
    return kind === 'BUILD' ? 'grove:tasks:build' : 'grove:tasks:asset-upload';
}

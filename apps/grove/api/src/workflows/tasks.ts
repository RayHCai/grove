import type { FastifyBaseLogger } from 'fastify';
import {
    AssetMediaType,
    MAX_ASSET_BYTES,
    VersionId,
    objectKey,
    uploadKey,
    type BuildArtifact,
    type BuildManifest,
    type Task,
    type TaskId,
    type TaskKind,
    type TaskStatusUpdate,
} from '@grove/api-contract';
import type { Fleet } from '../fleet.js';
import type { BuildWork, TaskSettled, Tasks, Workspaces } from '../records.js';
import { StorageUnavailable, type Storage } from '../storage.js';

export interface AdvanceDeps {
    tasks: Tasks;
    workspaces: Pick<Workspaces, 'fileOf'>;
    storage: Storage;
    fleet: Pick<Fleet, 'deploy'>;
    /** Each kind's lease, shorter than that kind's worker waits before it reclaims a message. */
    leases: Readonly<Record<TaskKind, number>>;
    log: FastifyBaseLogger;
}

/** One worker's claim or settle, of the one kind its secret answers for. */
export interface Advance {
    taskId: TaskId;
    kind: TaskKind;
    worker: string;
    update: TaskStatusUpdate;
    requestId: string;
}

/** `deployment` settles once the fleet is told of a version; nothing but a test waits on it. */
export type Advanced =
    | { outcome: 'advanced'; task: Task; deployment?: Promise<void> }
    | { outcome: 'refused'; message: string }
    | { outcome: 'invalid'; message: string }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/** Claims or settles one task; a success the API cannot confirm is recorded as a failure. */
export async function advanceTask(deps: AdvanceDeps, advance: Advance): Promise<Advanced> {
    if (advance.update.status === 'IN_PROGRESS') return claim(deps, advance);
    if (advance.update.status === 'SUCCESSFUL') {
        if (advance.kind === 'BUILD') return settleBuild(deps, advance);
        return settleUpload(deps, advance);
    }
    return answer(await deps.tasks.settleTask(advance.taskId, advance.kind, advance.update));
}

function answer(settled: TaskSettled): Advanced {
    if (settled.outcome === 'missing') return settled;
    if (settled.outcome === 'refused') {
        return { outcome: 'refused', message: `the task is already ${settled.task.status}` };
    }
    return { outcome: 'advanced', task: settled.task };
}

async function claim(deps: AdvanceDeps, { taskId, kind, worker }: Advance): Promise<Advanced> {
    const claimed = await deps.tasks.claimTask(taskId, {
        kind,
        worker,
        leaseMs: deps.leases[kind],
    });
    if (claimed.outcome === 'missing') return claimed;
    // Refused without counting an attempt, so a duplicate delivery is acknowledged, no more.
    if (claimed.outcome === 'held') {
        return { outcome: 'refused', message: 'the task is already claimed' };
    }
    if (claimed.outcome === 'settled') {
        return { outcome: 'refused', message: `the task is already ${claimed.task.status}` };
    }
    if (kind === 'BUILD') return { outcome: 'advanced', task: claimed.task };
    return inspection(deps, claimed.task, claimed.leaseUntil);
}

/** An upload worker's two presigned URLs, which expire with the lease they were claimed under. */
async function inspection(deps: AdvanceDeps, task: Task, leaseUntil: Date): Promise<Advanced> {
    const upload = await deps.tasks.uploadOf(task.taskId);
    if (upload === undefined) {
        const message = 'the upload was replaced before it was inspected';
        await deps.tasks.settleTask(task.taskId, 'ASSET_UPLOAD', {
            status: 'CANCELLED',
            detail: { message },
        });
        return { outcome: 'refused', message };
    }
    const contentType = AssetMediaType.safeParse(upload.contentType);
    if (!contentType.success || upload.byteLength < 1 || upload.byteLength > MAX_ASSET_BYTES) {
        const message = `${upload.path} is not a type or a size an asset may be`;
        await deps.tasks.settleTask(task.taskId, 'ASSET_UPLOAD', {
            status: 'FAILED',
            detail: { message },
        });
        return { outcome: 'refused', message };
    }

    const ttlS = Math.max(1, Math.floor((leaseUntil.getTime() - Date.now()) / 1000));
    const [source, destination] = await Promise.all([
        deps.storage.presignGet(uploadKey(upload.gameId, upload.path), upload.versionId, ttlS),
        deps.storage.presignPut(objectKey(upload.gameId, 'asset', upload.path), {
            contentType: contentType.data,
            expiresInS: ttlS,
        }),
    ]);
    if (source.outcome === 'unattached' || destination.outcome === 'unattached') {
        return { outcome: 'unattached' };
    }
    if (source.outcome !== 'signed' || destination.outcome !== 'signed') {
        throw new StorageUnavailable(upload.path);
    }
    return {
        outcome: 'advanced',
        task: {
            ...task,
            inspection: {
                source: source.url,
                destination: destination.url,
                contentType: contentType.data,
                byteLength: upload.byteLength,
                expiresAt: leaseUntil.toISOString(),
            },
        },
    };
}

/** A build's success is accepted only when every output it names is one the API stored for it. */
async function settleBuild(
    deps: AdvanceDeps,
    { taskId, update, requestId }: Advance,
): Promise<Advanced> {
    const build = update.detail?.build;
    if (build === undefined) {
        return { outcome: 'invalid', message: 'a build that succeeded names what it produced' };
    }
    const work = await deps.tasks.buildOf(taskId);
    if (work === undefined) return { outcome: 'missing' };

    if (!pinned(build, work, await deps.tasks.artifactsOf(taskId))) {
        const message = 'the build named an output that was not stored for it';
        const failed = await deps.tasks.settleTask(taskId, 'BUILD', {
            status: 'FAILED',
            detail: { message },
        });
        return failed.outcome === 'missing' ? failed : { outcome: 'refused', message };
    }

    const settled = answer(await deps.tasks.settleTask(taskId, 'BUILD', update));
    if (settled.outcome !== 'advanced') return settled;
    return { ...settled, deployment: deploy(deps, settled.task, requestId) };
}

function pinned(build: BuildManifest, work: BuildWork, stored: readonly BuildArtifact[]): boolean {
    if (build.gameId !== work.gameId || build.revision !== work.revision) return false;
    const { server, client, simConfig } = build.bundles;
    return [server, client, simConfig].every((ref) =>
        stored.some(
            (artifact) =>
                artifact.url === ref.url &&
                artifact.hash === ref.hash &&
                artifact.byteLength === ref.byteLength,
        ),
    );
}

/** Best effort, and only for the newest playable version, so a late older build drains nothing. */
async function deploy(deps: AdvanceDeps, task: Task, requestId: string): Promise<void> {
    try {
        const playable = await deps.tasks.playableVersionOf(task.gameId);
        if (playable === undefined || playable.revision !== task.manifestRevision) return;
        await deps.fleet.deploy(task.gameId, playable, requestId);
    } catch (error) {
        deps.log.warn({ err: error, taskId: task.taskId }, 'deployment not announced');
    }
}

/** An upload's success is checked against the copy it names before the asset counts as verified. */
async function settleUpload(deps: AdvanceDeps, { taskId, update }: Advance): Promise<Advanced> {
    const reported = VersionId.safeParse(update.detail?.versionId);
    if (!reported.success) {
        return { outcome: 'invalid', message: 'an upload that passed names the version it copied' };
    }
    const copied = reported.data;

    const upload = await deps.tasks.uploadOf(taskId);
    if (upload !== undefined) {
        const copy = await deps.storage.head(
            objectKey(upload.gameId, 'asset', upload.path),
            copied,
        );
        if (copy === undefined || copy.byteLength !== upload.byteLength) {
            const message = 'the inspected copy is not where the inspection said it is';
            const failed = await deps.tasks.settleTask(taskId, 'ASSET_UPLOAD', {
                status: 'FAILED',
                detail: { message },
            });
            if (failed.outcome === 'missing') return failed;
            await discardCopy(deps, failed.task, copied);
            return { outcome: 'refused', message };
        }
    }

    const settled = await deps.tasks.settleTask(
        taskId,
        'ASSET_UPLOAD',
        update,
        upload === undefined ? undefined : copied,
    );
    if (settled.outcome === 'missing') return settled;
    if (settled.outcome === 'refused' || !settled.validated) {
        await discardCopy(deps, settled.task, copied);
    }
    return answer(settled);
}

/** A copy no row names would otherwise be what the edge serves, over the one a row does name. */
async function discardCopy(deps: AdvanceDeps, task: Task, copied: VersionId): Promise<void> {
    if (task.assetPath === undefined) return;
    const file = await deps.workspaces.fileOf(task.gameId, task.assetPath);
    // A repeated settle of one success finds its own copy served, which is the one kept.
    if (file?.edgeVersionId === copied) return;
    await deps.storage.discard(objectKey(task.gameId, 'asset', task.assetPath), copied);
}

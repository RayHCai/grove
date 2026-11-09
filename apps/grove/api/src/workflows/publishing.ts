import type { FastifyBaseLogger } from 'fastify';
import type { GameId, PlayerId, Task, WorkspacePath } from '@grove/api-contract';
import { announce, type TaskQueue } from '../queue.js';
import type { Games, Tasks, Workspaces } from '../records.js';

export interface PublishDeps {
    games: Pick<Games, 'markPublished'>;
    workspaces: Pick<Workspaces, 'workspaceOf'>;
    tasks: Pick<Tasks, 'queueBuild'>;
    queue: TaskQueue;
    log: FastifyBaseLogger;
}

export type Published =
    | { outcome: 'queued' | 'existing'; task: Task }
    | { outcome: 'unsaved' }
    | { outcome: 'unverified'; paths: WorkspacePath[] }
    | { outcome: 'moved' }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/** Queues a build of the revision the last save froze, refused while an asset is unverified. */
export async function publish(
    deps: PublishDeps,
    game: GameId,
    account: PlayerId,
): Promise<Published> {
    const workspace = await deps.workspaces.workspaceOf(game);
    if (workspace === undefined) return { outcome: 'missing' };
    // Revision zero is a game nobody has saved, and a build of nothing is not a version.
    if (workspace.revision === 0) return { outcome: 'unsaved' };

    const queued = await deps.tasks.queueBuild(game, account, workspace.revision, workspace.saveId);
    if (queued.outcome !== 'queued' && queued.outcome !== 'existing') return queued;

    // Announced for an existing task too: the push is the half of queueing that can go missing.
    await announce(deps.queue, [queued.task], deps.log);
    // After the task exists, never before: a version nothing was asked to build is unplayable.
    if (queued.outcome === 'queued') {
        await deps.games.markPublished(game, {
            revision: workspace.revision,
            publishedAt: new Date().toISOString(),
        });
    }
    return queued;
}

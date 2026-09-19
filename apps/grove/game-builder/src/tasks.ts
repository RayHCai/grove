import { REQUEST_ID_HEADER, Task, type TaskId, type TaskStatusUpdate } from '@grove/api-contract';
import type { Env } from './env.js';

/**
 * `settled` is the task as it now stands; `refused` is @grove/api declining to move it, which is
 * what a redelivery of work somebody already finished earns.
 */
export type TaskWritten =
    { outcome: 'settled'; task: Task } | { outcome: 'refused' } | { outcome: 'unavailable' };

/**
 * Where this service says what it did with a task.
 *
 * The only call this process makes to @grove/api, and the reason it holds no database credential:
 * the transitions are checked there, so a builder that comes back from the dead and tries to settle
 * a task another box already finished is refused rather than overwriting it.
 */
export interface Tasks {
    advance(task: TaskId, update: TaskStatusUpdate, requestId: string): Promise<TaskWritten>;
}

/** Settling a task is a row update behind a bearer, not a compile: it answers or it is down. */
const SETTLE_TIMEOUT_MS = 5_000;

export function httpTasks(env: Env): Tasks {
    return {
        advance: async (task, update, requestId) => {
            const written = await fetch(`${env.API_URL}/v1/tasks/${task}`, {
                method: 'PATCH',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${env.FLEET_SECRET}`,
                    [REQUEST_ID_HEADER]: requestId,
                },
                body: JSON.stringify(update),
                signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
            }).catch(() => undefined);

            if (written === undefined) return { outcome: 'unavailable' };
            // Told outright that this attempt lost, rather than left to infer it from a status:
            // a builder that keeps retrying a settled task is one that never acknowledges it.
            if (written.status === 404 || written.status === 409) return { outcome: 'refused' };
            if (!written.ok) return { outcome: 'unavailable' };
            return { outcome: 'settled', task: Task.parse(await written.json()) };
        },
    };
}

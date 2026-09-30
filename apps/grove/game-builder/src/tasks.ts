import { Task, type TaskId, type TaskStatusUpdate } from '@grove/api-contract';
import type { ApiCall } from './store.js';

/**
 * `settled` is the task as it now stands; `refused` is @grove/api declining to move it, which is
 * what a redelivery of work somebody already finished earns.
 */
export type TaskWritten =
    { outcome: 'settled'; task: Task } | { outcome: 'refused' } | { outcome: 'unavailable' };

/**
 * Where this service says what it did with a task.
 *
 * Through @grove/api, and the reason this process holds no database credential: the transitions
 * are checked there, so a builder that comes back from the dead and tries to settle a task another
 * box already finished is refused rather than overwriting it.
 */
export interface Tasks {
    advance(task: TaskId, update: TaskStatusUpdate, requestId: string): Promise<TaskWritten>;
}

/** Settling a task is a row update behind a bearer, not a compile: it answers or it is down. */
const SETTLE_TIMEOUT_MS = 5_000;

export function httpTasks(call: ApiCall): Tasks {
    return {
        advance: async (task, update, requestId) => {
            const written = await call(`/v1/tasks/${task}`, requestId, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(update),
                timeoutMs: SETTLE_TIMEOUT_MS,
            });

            if (written === undefined) return { outcome: 'unavailable' };
            // Told outright that this attempt lost, rather than left to infer it from a status:
            // a builder that keeps retrying a settled task is one that never acknowledges it.
            if (written.status === 404 || written.status === 409) return { outcome: 'refused' };
            if (!written.ok) return { outcome: 'unavailable' };
            const parsed = Task.safeParse(await written.json().catch(() => undefined));
            return parsed.success
                ? { outcome: 'settled', task: parsed.data }
                : { outcome: 'unavailable' };
        },
    };
}

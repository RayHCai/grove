import { Task, type TaskId, type TaskStatusUpdate } from '@grove/api-contract';
import type { ApiCall } from './store.js';

/** `refused` is work somebody already finished; `invalid` is a body the API would not parse. */
export type TaskWritten =
    | { outcome: 'settled'; task: Task }
    | { outcome: 'refused' }
    | { outcome: 'invalid' }
    | { outcome: 'unavailable' };

/** Where this service says what it did with a task, checked at @grove/api against the rest. */
export interface Tasks {
    advance(task: TaskId, update: TaskStatusUpdate, requestId: string): Promise<TaskWritten>;
}

/** Settling a task is a row update behind a bearer, not a compile: it answers or it is down. */
const SETTLE_TIMEOUT_MS = 5_000;

/** Where a worker names itself, which @grove/api records as the holder of a claim. */
const WORKER_HEADER = 'x-grove-worker';

export function httpTasks(call: ApiCall, worker: string): Tasks {
    return {
        advance: async (task, update, requestId) => {
            const written = await call(`/v1/tasks/${task}`, requestId, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', [WORKER_HEADER]: worker },
                body: JSON.stringify(update),
                timeoutMs: SETTLE_TIMEOUT_MS,
            });

            if (written === undefined) return { outcome: 'unavailable' };
            // Told outright that this attempt lost, so it acknowledges rather than retrying.
            if (written.status === 404 || written.status === 409) return { outcome: 'refused' };
            if (written.status === 400) return { outcome: 'invalid' };
            if (!written.ok) return { outcome: 'unavailable' };
            const parsed = Task.safeParse(await written.json().catch(() => undefined));
            return parsed.success
                ? { outcome: 'settled', task: parsed.data }
                : { outcome: 'unavailable' };
        },
    };
}

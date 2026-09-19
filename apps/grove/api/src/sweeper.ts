import { TaskKind, type TaskKind as Kind } from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';
import type { TaskQueue } from './queue.js';
import type { Records } from './records.js';

/** How many of one kind are re-pushed per pass, so a backlog drains over passes rather than at once. */
const SWEEP_WIDTH = 50;

/**
 * Re-announces work nothing was ever told about.
 *
 * The row is written before the push, so the failure this exists for is a task committed and a
 * message that never reached its stream — a Redis that was down for a second, a process that died
 * between the two. Without this, that task sits in NOT_STARTED until somebody notices.
 *
 * It only ever re-pushes: a consumer group already redelivers what a dead worker claimed, so a task
 * in IN_PROGRESS is the stream's problem and not this one's.
 */
export function sweepTasks(
    records: Records,
    queue: TaskQueue,
    env: Env,
    log: FastifyBaseLogger,
): { stop: () => void } {
    const pass = async (): Promise<void> => {
        const before = new Date(Date.now() - env.TASK_SWEEP_AFTER_MS);
        for (const kind of TaskKind.options as Kind[]) {
            // oxlint-disable-next-line no-await-in-loop
            const stale = await records.unclaimedTasks(kind, before, SWEEP_WIDTH);
            for (const task of stale) {
                // oxlint-disable-next-line no-await-in-loop
                const pushed = await queue.push(kind, task.taskId);
                if (pushed.outcome === 'pushed') {
                    log.warn({ taskId: task.taskId, kind }, 'task re-announced');
                }
            }
        }
    };

    const timer = setInterval(() => {
        // A failed pass is the next pass's problem: this runs forever, and an unhandled rejection
        // here would take the one service every browser talks to down with it.
        void pass().catch((error: unknown) => {
            log.error({ err: error }, 'task sweep failed');
        });
    }, env.TASK_SWEEP_INTERVAL_MS);
    // Nothing waits on this, so it must not be the reason the process stays alive at shutdown.
    timer.unref();

    return { stop: () => clearInterval(timer) };
}

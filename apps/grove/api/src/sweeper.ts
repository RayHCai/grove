import { TaskKind, type TaskId, type TaskKind as Kind } from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import { leaseOf, type Env } from './env.js';
import type { TaskQueue } from './queue.js';
import type { Tasks } from './records.js';
import type { Sessions } from './sessions.js';

/** How many of one kind are re-announced per pass, so a backlog drains over passes. */
const SWEEP_WIDTH = 50;

/** A claim nobody came back to for this many lease windows is a task no worker will finish. */
export const REAP_AFTER_LEASES = 3;

/** Expired sessions are already refused on read, so pruning them is housekeeping, hourly. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface Swept {
    announced: TaskId[];
    reaped: TaskId[];
}

/** One pass: re-announces what nothing was told about lately, then fails what was abandoned. */
export async function sweepOnce(
    tasks: Pick<Tasks, 'dueForAnnouncement' | 'markAnnounced' | 'reapAbandoned'>,
    queue: TaskQueue,
    env: Pick<Env, 'TASK_SWEEP_AFTER_MS' | 'BUILD_LEASE_MS' | 'ASSET_UPLOAD_LEASE_MS'>,
    log: FastifyBaseLogger,
    now: number = Date.now(),
): Promise<Swept> {
    const before = new Date(now - env.TASK_SWEEP_AFTER_MS);
    const kinds = await Promise.all(
        (TaskKind.options as Kind[]).map(async (kind): Promise<Swept> => {
            const due = await tasks.dueForAnnouncement(kind, before, new Date(now), SWEEP_WIDTH);
            const pushed = await Promise.all(
                due.map(async (task) => ({ task, pushed: await queue.push(kind, task) })),
            );
            // Only what the stream took is marked, so a push that failed is due again next pass.
            const landed = pushed
                .filter((each) => each.pushed.outcome === 'pushed')
                .map((each) => each.task);
            await tasks.markAnnounced(landed, new Date(now));
            if (landed.length > 0) log.warn({ kind, tasks: landed }, 'tasks re-announced');

            const abandoned = await tasks.reapAbandoned(
                kind,
                new Date(now - (REAP_AFTER_LEASES - 1) * leaseOf(env, kind)),
                `no worker finished this within ${String(REAP_AFTER_LEASES)} claims' time`,
            );
            if (abandoned.length > 0)
                log.error({ kind, tasks: abandoned }, 'abandoned tasks failed');
            return { announced: landed, reaped: abandoned };
        }),
    );
    return {
        announced: kinds.flatMap((kind) => kind.announced),
        reaped: kinds.flatMap((kind) => kind.reaped),
    };
}

/** Runs a pass every interval; a failed pass is the next one's problem and never the process's. */
export function sweepTasks(
    tasks: Tasks,
    queue: TaskQueue,
    env: Env,
    log: FastifyBaseLogger,
): { stop: () => void } {
    const timer = setInterval(() => {
        void sweepOnce(tasks, queue, env, log).catch((error: unknown) => {
            log.error({ err: error }, 'task sweep failed');
        });
    }, env.TASK_SWEEP_INTERVAL_MS);
    // Nothing waits on this, so it must not be what keeps the process alive at shutdown.
    timer.unref();
    return { stop: () => clearInterval(timer) };
}

/** Drops expired sessions on an interval, so the table holds what a cookie can still present. */
export function pruneSessions(sessions: Sessions, log: FastifyBaseLogger): { stop: () => void } {
    const timer = setInterval(() => {
        void sessions.prune().catch((error: unknown) => {
            log.error({ err: error }, 'session prune failed');
        });
    }, PRUNE_INTERVAL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
}

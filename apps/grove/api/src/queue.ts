import { Redis } from 'ioredis';
import { databaseOf, streamOf, type TaskId, type TaskKind } from '@grove/api-contract';

/** Only `pushed` names work a consumer will be woken for; the row is written either way. */
export type TaskPushed =
    { outcome: 'pushed' } | { outcome: 'unattached' } | { outcome: 'unavailable' };

/**
 * Where a queued task is announced to whichever service runs that kind.
 *
 * A stream and not a list: a consumer group is what lets a worker claim a message, keep it claimed
 * while it works, and hand it back when it dies. The message carries a task id and nothing else:
 * the row was written first, so a worker reads the work from the database and a push that never
 * landed is still a row the sweeper finds.
 */
export interface TaskQueue {
    push(kind: TaskKind, task: TaskId): Promise<TaskPushed>;
    close(): Promise<void>;
}

/** The stream seam with nothing behind it: Redis lands here. */
export const unattachedQueue: TaskQueue = {
    // Naming the seam rather than reporting success, so the route logs a task nothing was told
    // about instead of believing a worker heard of it.
    push: async () => ({ outcome: 'unattached' }),
    close: async () => undefined,
};

/** How long a stream may keep the ids of work already settled, which is a debugging window. */
const STREAM_LENGTH = 10_000;

/** Redis streams, one per kind, each in the database that kind's workers read. */
export function redisQueue(url: string): TaskQueue {
    // One connection per kind, because `SELECT` pins a connection to a database and the kinds no
    // longer share one. Opened on first push, so a deployment that only ever queues builds holds
    // one socket rather than one per kind it has.
    const held = new Map<TaskKind, Redis>();

    const connectionFor = (kind: TaskKind): Redis => {
        const open = held.get(kind);
        if (open !== undefined) return open;
        const redis = new Redis(url, {
            // An explicit option beats the URL's own path in ioredis, which is what makes the
            // contract the one place a database number is decided: a connection string that names
            // a different one cannot quietly win.
            db: databaseOf(kind),
            // A push that did not land is logged and left to the sweeper, so an unbounded retry
            // here would hold a creator's save open for nothing.
            maxRetriesPerRequest: 2,
            lazyConnect: true,
        });
        held.set(kind, redis);
        return redis;
    };

    return {
        push: async (kind, task) => {
            // Trimmed approximately: an exact cap makes every push scan, and what this bounds is
            // memory rather than a guarantee anything depends on.
            const pushed = await connectionFor(kind)
                .xadd(streamOf(kind), 'MAXLEN', '~', STREAM_LENGTH, '*', 'taskId', task)
                .catch(() => undefined);
            return pushed === undefined || pushed === null
                ? { outcome: 'unavailable' }
                : { outcome: 'pushed' };
        },

        close: async () => {
            await Promise.all(
                [...held.values()].map((redis) => redis.quit().catch(() => undefined)),
            );
        },
    };
}

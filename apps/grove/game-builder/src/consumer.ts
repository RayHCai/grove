import type { Redis } from 'ioredis';
import { TaskId, streamOf } from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';
import type { Manifests } from './manifests.js';
import type { Tasks } from './tasks.js';

/** The group every build box reads under; the name is the group, so a second box shares the work. */
const GROUP = 'game-builder';

/** How long a read waits for work before the loop comes back round to reclaim and check for a stop. */
const BLOCK_MS = 5_000;

/** One message at a time: a build holds the box, so reading ten would be nine sitting claimed. */
const BATCH = 1;

/**
 * What one build did with its message.
 *
 * `settled` is acknowledged — the outcome is written down, whatever it was. `retry` leaves the
 * message claimed so another box takes it back after the reclaim window, which is what a failure
 * of the fleet rather than of the source earns.
 */
export type Handled = 'settled' | 'retry';

export interface Builder {
    tasks: Tasks;
    manifests: Manifests;
    log: FastifyBaseLogger;
}

/**
 * Claims one task, compiles what its manifest names, and settles it.
 *
 * The claim is what tells this box what to build: the message carries a task id and nothing else,
 * and the answer to the claim carries the game and the manifest revision. That is deliberate — the
 * row is the truth, and a message that has been sitting in a stream for ten minutes is not.
 */
export async function runBuild(taskId: TaskId, builder: Builder): Promise<Handled> {
    const { tasks, manifests, log } = builder;

    const claimed = await tasks.advance(taskId, { status: 'IN_PROGRESS' }, taskId);
    // Somebody already settled it, so this is a redelivery of finished work: acknowledged rather
    // than retried, or it comes back forever.
    if (claimed.outcome === 'refused') {
        log.info({ taskId }, 'build already settled');
        return 'settled';
    }
    if (claimed.outcome !== 'settled') {
        log.warn({ taskId }, 'task could not be claimed');
        return 'retry';
    }

    const task = claimed.task;
    const manifest = await manifests.read(task.gameId, task.manifestRevision);
    if (manifest === undefined) {
        // Against the box and not against a creator's file: nothing in their source can make a
        // manifest unreadable, and a diagnostic pointing at one of their lines would be a lie.
        await tasks.advance(
            taskId,
            { status: 'FAILED', detail: { message: 'the manifest could not be read' } },
            taskId,
        );
        log.error(
            { taskId, gameId: task.gameId, revision: task.manifestRevision },
            'manifest unreadable',
        );
        return 'settled';
    }

    const byteLength = manifest.files.reduce((total, file) => total + file.byteLength, 0);
    log.info(
        {
            taskId,
            gameId: task.gameId,
            revision: task.manifestRevision,
            fileCount: manifest.files.length,
            byteLength,
            paths: manifest.files.map((file) => file.path),
        },
        'build source read',
    );

    const settled = await tasks.advance(
        taskId,
        { status: 'SUCCESSFUL', detail: { fileCount: manifest.files.length, byteLength } },
        taskId,
    );
    // The outcome could not be written down, so the work has to come back: acknowledging here
    // would leave a creator watching a task nothing will ever move.
    if (settled.outcome === 'unavailable') return 'retry';
    return 'settled';
}

/**
 * Reads the build stream forever, one task at a time.
 *
 * A consumer group rather than a list, so a box that dies mid-build hands its claim back instead of
 * taking the build with it: `XAUTOCLAIM` is what another box reclaims through, and the window is
 * the build deadline, because a compile legitimately holds a claim for minutes.
 */
export function startConsumer(
    redis: Redis,
    builder: Builder,
    env: Env,
    name: string,
): { stop: () => Promise<void> } {
    const stream = streamOf('BUILD');
    // An abort rather than a flag: the loop's condition is then something the reader can see is
    // changed from outside it, which a plain boolean closed over is not.
    const stopping = new AbortController();

    const handle = async (id: string, fields: string[]): Promise<void> => {
        const at = fields.indexOf('taskId');
        const parsed = TaskId.safeParse(at === -1 ? undefined : fields[at + 1]);
        if (!parsed.success) {
            // Nothing this service can ever do with it, and leaving it pending would make every
            // reclaim pass pick it up again.
            builder.log.error({ id }, 'message names no task');
            await redis.xack(stream, GROUP, id);
            return;
        }
        if ((await runBuild(parsed.data, builder)) === 'settled') {
            await redis.xack(stream, GROUP, id);
        }
    };

    const loop = async (): Promise<void> => {
        // MKSTREAM, because the group has to exist before the first publish rather than after it.
        await redis.xgroup('CREATE', stream, GROUP, '0', 'MKSTREAM').catch(() => undefined);

        while (!stopping.signal.aborted) {
            // Reclaimed first: a build another box died holding is older work than anything new,
            // and a creator waiting on it has been waiting longest.
            // oxlint-disable-next-line no-await-in-loop
            const reclaimed = (await redis
                .xautoclaim(stream, GROUP, name, env.BUILD_TIMEOUT_MS, '0', 'COUNT', BATCH)
                .catch(() => undefined)) as [string, [string, string[]][]] | undefined;
            for (const [id, fields] of reclaimed?.[1] ?? []) {
                // oxlint-disable-next-line no-await-in-loop
                await handle(id, fields);
            }

            // oxlint-disable-next-line no-await-in-loop
            const read = (await redis
                .xreadgroup(
                    'GROUP',
                    GROUP,
                    name,
                    'COUNT',
                    BATCH,
                    'BLOCK',
                    BLOCK_MS,
                    'STREAMS',
                    stream,
                    '>',
                )
                .catch(() => undefined)) as [string, [string, string[]][]][] | null | undefined;

            for (const [, messages] of read ?? []) {
                for (const [id, fields] of messages) {
                    // oxlint-disable-next-line no-await-in-loop
                    await handle(id, fields);
                }
            }
        }
    };

    const draining = loop().catch((error: unknown) => {
        builder.log.error({ err: error }, 'build consumer stopped');
    });

    return {
        stop: async () => {
            stopping.abort();
            // The blocking read is what this waits out, which is why the block is seconds and not
            // minutes: a deploy should not sit on a socket waiting for work that is not coming.
            await draining;
        },
    };
}

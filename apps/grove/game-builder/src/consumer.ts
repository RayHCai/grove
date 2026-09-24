import type { Redis } from 'ioredis';
import {
    BuildManifest,
    TaskId,
    buildManifestKey,
    streamOf,
    type BuildArtifact,
    type BundleRef,
    type Manifest,
    type Task,
    type TaskDetail,
} from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import { compile, type SourceFile } from './compile.js';
import type { Env } from './env.js';
import type { BuildStore } from './store.js';
import type { Tasks } from './tasks.js';

/** The group every build box reads under; the name is the group, so a second box shares the work. */
const GROUP = 'game-builder';

/** How long a read waits for work before the loop comes back round to reclaim and check for a stop. */
const BLOCK_MS = 5_000;

/** One message at a time: a build holds the box, so reading ten would be nine sitting claimed. */
const BATCH = 1;

/** The three files a build produces beside its manifest, in the order they have to be written. */
const CLIENT = 'client.js';
const SIM_CONFIG = 'simConfig.json';
const SERVER = 'server.js';

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
    store: BuildStore;
    env: Env;
    log: FastifyBaseLogger;
}

/**
 * Claims one task, compiles the revision it names, and settles it.
 *
 * The claim is what tells this box what to build: the message carries a task id and nothing else,
 * and the answer to the claim carries the game and the manifest revision. That is deliberate — the
 * row is the truth, and a message that has been sitting in a stream for ten minutes is not.
 *
 * A build is atomic. There is no resuming a half-finished one, because the work is a compile of a
 * handful of modules and the bookkeeping that would let it resume costs more than starting again.
 */
export async function runBuild(taskId: TaskId, builder: Builder): Promise<Handled> {
    const { tasks, env, log } = builder;

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
    log.info({ taskId, gameId: task.gameId, revision: task.manifestRevision }, 'build claimed');

    const built = await produce(task, builder);
    if (built.outcome === 'unavailable') {
        // The count is the row's rather than this process's, so a fault that looks transient on
        // every box in turn still stops: a build restarted forever is a creator watching a task
        // that will never move.
        if (task.attempts < env.BUILD_ATTEMPTS) {
            log.warn({ taskId, attempts: task.attempts }, built.message);
            return 'retry';
        }
        return settle(taskId, 'FAILED', { message: built.message }, builder);
    }

    return built.outcome === 'rejected'
        ? settle(
              taskId,
              'FAILED',
              { message: built.message, diagnostics: built.diagnostics },
              builder,
          )
        : settle(taskId, 'SUCCESSFUL', built.detail, builder);
}

type Produced =
    | { outcome: 'built'; detail: TaskDetail }
    | { outcome: 'rejected'; message: string; diagnostics: NonNullable<TaskDetail['diagnostics']> }
    | { outcome: 'unavailable'; message: string };

/** Reads the pinned source, compiles it, and stores what came out. */
async function produce(task: Task, builder: Builder): Promise<Produced> {
    const { store, log } = builder;
    const game = task.gameId;
    const revision = task.manifestRevision;

    const frozen = await store.manifest(game, revision, task.taskId);
    // A revision nothing froze is a build of a manifest that does not exist, which no box will
    // ever do better with.
    if (frozen.outcome === 'missing') {
        return {
            outcome: 'rejected',
            message: `revision ${String(revision)} was never saved`,
            diagnostics: [],
        };
    }
    if (frozen.outcome !== 'found') {
        return { outcome: 'unavailable', message: 'the manifest could not be read' };
    }

    const sources = await read(frozen.value, task, builder);
    if (sources.outcome !== 'read') return sources;

    const compiled = await compile(task.taskId, sources.files);
    if (compiled.outcome !== 'compiled') return compiled;

    const { output } = compiled;
    log.info({ taskId: task.taskId, scripts: output.project.scriptModules.length }, 'build linked');

    // The client half first: what it hashes to is what a joining browser has to be running, and
    // the world booted below is told that hash rather than deriving one of its own.
    const client = await store.store(
        game,
        revision,
        CLIENT,
        output.client,
        'text/javascript',
        task.taskId,
    );
    if (client.outcome !== 'stored')
        return { outcome: 'unavailable', message: 'the client half could not be stored' };

    const simConfig = await store.store(
        game,
        revision,
        SIM_CONFIG,
        Buffer.from(
            JSON.stringify({
                simRate: output.project.settings.simRate,
                sendRate: output.project.settings.sendRate,
                project: {
                    projectId: output.project.projectId,
                    // `contentHash` IS `projectHash` on the wire — the handshake compares a digest
                    // of what was authored, and the two names are one value.
                    projectHash: output.project.contentHash,
                    bundleHash: client.artifact.hash,
                    bundleUrl: client.artifact.url,
                },
            }),
            'utf8',
        ),
        'application/json',
        task.taskId,
    );
    if (simConfig.outcome !== 'stored') {
        return { outcome: 'unavailable', message: 'the world config could not be stored' };
    }

    const server = await store.store(
        game,
        revision,
        SERVER,
        output.server,
        'text/javascript',
        task.taskId,
    );
    if (server.outcome !== 'stored') {
        return { outcome: 'unavailable', message: 'the server half could not be stored' };
    }

    const manifest: BuildManifest = BuildManifest.parse({
        gameId: game,
        revision,
        projectId: output.project.projectId,
        projectHash: output.project.contentHash,
        bundles: {
            server: bundleRef('server', server.artifact),
            client: bundleRef('client', client.artifact),
            simConfig: {
                hash: simConfig.artifact.hash,
                url: simConfig.artifact.url,
                byteLength: simConfig.artifact.byteLength,
            },
            syncedHash: output.syncedHash,
        },
    });

    // Written last, and it is the commit marker: everything above is inert until a build manifest
    // names it, so a box that died mid-build leaves chunks nothing reads rather than a half-built
    // version somebody can be sent at.
    const written = await store.store(
        game,
        revision,
        nameOf(buildManifestKey(game, revision)),
        Buffer.from(JSON.stringify(manifest), 'utf8'),
        'application/json',
        task.taskId,
    );
    if (written.outcome !== 'stored') {
        return { outcome: 'unavailable', message: 'the build manifest could not be stored' };
    }

    return {
        outcome: 'built',
        detail: {
            build: manifest,
            fileCount: 4,
            byteLength:
                client.artifact.byteLength +
                server.artifact.byteLength +
                simConfig.artifact.byteLength +
                written.artifact.byteLength,
        },
    };
}

type Read =
    | { outcome: 'read'; files: SourceFile[] }
    | { outcome: 'rejected'; message: string; diagnostics: [] }
    | { outcome: 'unavailable'; message: string };

/**
 * The text of every source the manifest names.
 *
 * Assets are passed over: their bytes are fetched by a client from the edge, and what a compile
 * needs of one is the record in the project manifest rather than the file itself.
 */
async function read(manifest: Manifest, task: Task, builder: Builder): Promise<Read> {
    const files: SourceFile[] = [];
    for (const file of manifest.files) {
        if (file.kind !== 'source') continue;
        // oxlint-disable-next-line no-await-in-loop
        const fetched = await builder.store.file(
            task.gameId,
            task.manifestRevision,
            file.path,
            task.taskId,
        );
        // A manifest naming a file the bucket does not hold is a save that lost its bytes, and no
        // box will do better with it.
        if (fetched.outcome === 'missing') {
            return {
                outcome: 'rejected',
                message: `${file.path} is named by revision ${String(task.manifestRevision)} and is not in the bucket`,
                diagnostics: [],
            };
        }
        if (fetched.outcome !== 'found') {
            return { outcome: 'unavailable', message: `${file.path} could not be read` };
        }
        files.push({ path: file.path, text: fetched.value.toString('utf8') });
    }
    return { outcome: 'read', files };
}

/** The last segment of a key, which is the only part of one this box is allowed to name. */
function nameOf(key: string): string {
    return key.slice(key.lastIndexOf('/') + 1);
}

function bundleRef(side: BundleRef['side'], artifact: BuildArtifact): BundleRef {
    return { side, hash: artifact.hash, url: artifact.url, byteLength: artifact.byteLength };
}

/** Writes the outcome down; a status route that would not answer leaves the work to come back. */
async function settle(
    taskId: TaskId,
    status: 'SUCCESSFUL' | 'FAILED',
    detail: TaskDetail,
    builder: Builder,
): Promise<Handled> {
    const settled = await builder.tasks.advance(taskId, { status, detail }, taskId);
    // The outcome could not be written down, so the work has to come back: acknowledging here
    // would leave a creator watching a task nothing will ever move.
    if (settled.outcome === 'unavailable') return 'retry';
    builder.log.info({ taskId, status }, 'build settled');
    return 'settled';
}

/**
 * Reads the build stream forever, one task at a time.
 *
 * A consumer group rather than a list, so a box that dies mid-build hands its claim back instead of
 * taking the build with it: `XAUTOCLAIM` is what another box reclaims through, and the window is
 * the build deadline — which is sized for an infrastructure failure to be noticed, since the
 * compile itself is under a minute.
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
            const delivered = (await redis
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

            for (const [, messages] of delivered ?? []) {
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

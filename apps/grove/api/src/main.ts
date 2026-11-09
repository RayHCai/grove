import { SESSION_TTL_MS, buildApp } from './app.js';
import { readEnv } from './env.js';
import { httpFleet } from './fleet.js';
import { loggingMailer, unattachedMailer } from './mailer.js';
import { redisQueue, unattachedQueue } from './queue.js';
import { unattachedStores } from './records.js';
import { MemorySessions } from './sessions.js';
import { s3Storage, unattachedStorage } from './storage.js';
import { connect, prismaSessions, prismaStores } from './store/index.js';
import { pruneSessions, sweepTasks } from './sweeper.js';

/** Past this a shutdown is a hung socket, and the platform's own kill would come less politely. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

// `readEnv` refuses a production process missing any seam, so an absent one is development or test.
const env = readEnv();

const db = env.DATABASE_URL === undefined ? undefined : connect(env.DATABASE_URL);
const stores = db === undefined ? unattachedStores : prismaStores(db);
const sessions =
    db === undefined ? new MemorySessions(SESSION_TTL_MS) : prismaSessions(db, SESSION_TTL_MS);
const storage =
    env.GAMES_BUCKET === undefined
        ? unattachedStorage
        : s3Storage(env, env.GAMES_BUCKET, () => app.log);
const queue = env.REDIS_URL === undefined ? unattachedQueue : redisQueue(env.REDIS_URL);

// A reset link in the log is a delivered reset to whoever reads the log, so production has none.
const mailer = env.NODE_ENV === 'production' ? unattachedMailer : loggingMailer(() => app.log);

const app = await buildApp(env, {
    ...stores,
    sessions,
    fleet: httpFleet(env),
    storage,
    queue,
    mailer,
});

const unattached = [
    ...(db === undefined ? ['DATABASE_URL'] : []),
    ...(env.GAMES_BUCKET === undefined ? ['GAMES_BUCKET'] : []),
    ...(env.REDIS_URL === undefined ? ['REDIS_URL'] : []),
];
if (unattached.length > 0) {
    app.log.warn({ unattached }, 'seams left unattached');
}

// Started here rather than in `buildApp`, since a test building the app asked for no timers.
const sweeper = sweepTasks(stores.tasks, queue, env, app.log);
const pruner = pruneSessions(sessions, app.log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        sweeper.stop();
        pruner.stop();
        setTimeout(() => {
            app.log.error('shutdown did not finish in time');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
        void app
            .close()
            .then(() => queue.close())
            .then(() => db?.$disconnect())
            .then(
                () => process.exit(0),
                (error: unknown) => {
                    app.log.error({ err: error }, 'shutdown failed');
                    process.exit(1);
                },
            );
    });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });

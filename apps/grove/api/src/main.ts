import { buildApp } from './app.js';
import { readEnv } from './env.js';
import { httpFleet } from './fleet.js';
import { loggingMailer, unattachedMailer } from './mailer.js';
import { redisQueue, unattachedQueue } from './queue.js';
import { unattachedRecords } from './records.js';
import { s3Storage, unattachedStorage } from './storage.js';
import { connect, prismaRecords } from './store.js';
import { sweepTasks } from './sweeper.js';

/** Past this a shutdown is a hung socket, and the platform's own kill would come less politely. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

// `readEnv` refuses a production process missing any of these, so an absent one here is a
// development or test process, where every route already answers for the seam it lacks.
const env = readEnv();

const db = env.DATABASE_URL === undefined ? undefined : connect(env.DATABASE_URL);
const records = db === undefined ? unattachedRecords : prismaRecords(db);
const storage =
    env.GAMES_BUCKET === undefined
        ? unattachedStorage
        : s3Storage(env, env.GAMES_BUCKET, () => app.log);
const queue = env.REDIS_URL === undefined ? unattachedQueue : redisQueue(env.REDIS_URL);

// A reset link in the log is a delivered password reset to everybody who can read the log, so this
// is the one seam chosen by `NODE_ENV` rather than by a URL: a deployed process has no mailer until
// somebody attaches a provider here, and asking for a reset says so with a 501 rather than posting
// the link where it can be read.
const mailer = env.NODE_ENV === 'production' ? unattachedMailer : loggingMailer(() => app.log);

const app = await buildApp(env, records, httpFleet(env), storage, queue, mailer);

const unattached = [
    ...(db === undefined ? ['DATABASE_URL'] : []),
    ...(env.GAMES_BUCKET === undefined ? ['GAMES_BUCKET'] : []),
    ...(env.REDIS_URL === undefined ? ['REDIS_URL'] : []),
];
if (unattached.length > 0) {
    app.log.warn({ unattached }, 'seams left unattached');
}

// Started here rather than inside `buildApp`: a test builds the app to drive routes, and a timer
// re-pushing work every thirty seconds is not something a test asked for.
const sweeper = sweepTasks(records, queue, env, app.log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        sweeper.stop();
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

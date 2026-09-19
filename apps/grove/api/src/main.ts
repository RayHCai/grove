import { buildApp } from './app.js';
import { readEnv } from './env.js';
import { httpFleet } from './fleet.js';
import { loggingMailer, unattachedMailer } from './mailer.js';
import { redisQueue, unattachedQueue } from './queue.js';
import { unattachedRecords } from './records.js';
import { s3Storage, unattachedStorage } from './storage.js';
import { connect, prismaRecords } from './store.js';
import { sweepTasks } from './sweeper.js';

const env = readEnv();

// Named rather than defaulted: with no database behind it every sign-in is a 401 and every route
// behind the cookie answers as though nobody holds an account, which is what a process pointed at
// nothing should do rather than refuse to start. The bucket and the streams are the same bargain —
// a save says it has nowhere to put a file instead of the process failing to boot.
const db = env.DATABASE_URL === undefined ? undefined : connect(env.DATABASE_URL);
const records = db === undefined ? unattachedRecords : prismaRecords(db);
const storage =
    env.GAMES_BUCKET === undefined ? unattachedStorage : s3Storage(env, env.GAMES_BUCKET);
const queue = env.REDIS_URL === undefined ? unattachedQueue : redisQueue(env, env.REDIS_URL);

// A reset link in the log is a delivered password reset to everybody who can read the log, so this
// is the one seam chosen by `NODE_ENV` rather than by a URL: a deployed process has no mailer until
// somebody attaches a provider here, and asking for a reset says so with a 501 rather than posting
// the link where it can be read.
const mailer = env.NODE_ENV === 'production' ? unattachedMailer : loggingMailer(() => app.log);

const app = await buildApp(env, records, httpFleet(env), storage, queue, mailer);

// Started here rather than inside `buildApp`: a test builds the app to drive routes, and a timer
// re-pushing work every thirty seconds is not something a test asked for.
const sweeper = sweepTasks(records, queue, env, app.log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        sweeper.stop();
        void app
            .close()
            .then(() => queue.close())
            .then(() => db?.$disconnect())
            .then(() => process.exit(0));
    });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });

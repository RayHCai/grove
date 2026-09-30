import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { databaseOf } from '@grove/api-contract';
import { buildApp } from './app.js';
import { startConsumer, type Consumer } from './consumer.js';
import { readEnv } from './env.js';
import { apiCall, httpStore } from './store.js';
import { httpTasks } from './tasks.js';

/** A build in flight is given this long to settle before the process leaves it to the reclaim. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

const env = readEnv();

// The process comes up either way, and a box with no stream behind it says so on its health route
// rather than refusing to start: a host agent can tell a 503 from a box that is simply gone.
const redis =
    env.REDIS_URL === undefined
        ? undefined
        : // The database is the contract's and never the URL's, so this box reads the one
          // @grove/api pushed a build to even where both were handed one connection string.
          new Redis(env.REDIS_URL, { db: databaseOf('BUILD') });

let consumer: Consumer | undefined;
const app = await buildApp(env, () => {
    if (consumer === undefined) return { ok: false, reason: 'no build stream is attached' };
    return consumer.running() ? { ok: true } : { ok: false, reason: 'the build consumer stopped' };
});

if (redis === undefined) {
    app.log.error('no build stream is attached; nothing will be claimed');
} else {
    const call = apiCall(env);
    consumer = startConsumer(
        redis,
        { tasks: httpTasks(call), store: httpStore(call), env, log: app.log },
        env,
        // Two boxes sharing a consumer name share their claims, so one would acknowledge work the
        // other is still doing.
        env.BUILDER_NAME === '' ? hostname() : env.BUILDER_NAME,
    );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        setTimeout(() => {
            app.log.error('shutdown did not finish in time');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
        // The consumer first: a build in flight settles or is left claimed for another box, and
        // either is better than a socket closed under it.
        void Promise.resolve(consumer?.stop())
            .then(() => app.close())
            .then(() => redis?.quit())
            .then(
                () => process.exit(0),
                (error: unknown) => {
                    app.log.error({ err: error }, 'shutdown failed');
                    process.exit(1);
                },
            );
    });
}

await app.listen({ host: env.GAME_BUILDER_HOST, port: env.GAME_BUILDER_PORT });

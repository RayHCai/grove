import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { databaseOf } from '@grove/api-contract';
import { buildApp } from './app.js';
import { startConsumer } from './consumer.js';
import { readEnv } from './env.js';
import { httpStore } from './store.js';
import { httpTasks } from './tasks.js';

const env = readEnv();
const app = await buildApp(env);

// The health endpoint comes up either way. A box with no stream behind it settles nothing, which is
// a wiring fault to see in the logs rather than a process that will not start — and one that
// refuses to boot is one no host agent can tell apart from a box that is simply gone.
const redis =
    env.REDIS_URL === undefined
        ? undefined
        : // The database is the contract's and never the URL's, so this box reads the one
          // @grove/api pushed a build to even where both were handed one connection string.
          new Redis(env.REDIS_URL, { db: databaseOf('BUILD') });
const consumer =
    redis === undefined
        ? undefined
        : startConsumer(
              redis,
              { tasks: httpTasks(env), store: httpStore(env), env, log: app.log },
              env,
              // Two boxes sharing a consumer name share their claims, so one would acknowledge work
              // the other is still doing.
              env.BUILDER_NAME === '' ? hostname() : env.BUILDER_NAME,
          );

if (redis === undefined) app.log.error('no build stream is attached; nothing will be claimed');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        // The consumer first: a build in flight settles or is left claimed for another box, and
        // either is better than a socket closed under it.
        void Promise.resolve(consumer?.stop())
            .then(() => app.close())
            .then(() => redis?.quit())
            .then(() => process.exit(0));
    });
}

await app.listen({ host: env.GAME_BUILDER_HOST, port: env.GAME_BUILDER_PORT });

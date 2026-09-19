import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { startConsumer } from './consumer.js';
import { readEnv } from './env.js';
import { s3Manifests, unattachedManifests } from './manifests.js';
import { httpTasks } from './tasks.js';

const env = readEnv();
const app = await buildApp(env);

// The health endpoint comes up either way. A box with no stream behind it settles nothing, which is
// a wiring fault to see in the logs rather than a process that will not start — and one that
// refuses to boot is one no host agent can tell apart from a box that is simply gone.
const manifests =
    env.GAMES_BUCKET === undefined ? unattachedManifests : s3Manifests(env, env.GAMES_BUCKET);

const redis = env.REDIS_URL === undefined ? undefined : new Redis(env.REDIS_URL);
const consumer =
    redis === undefined
        ? undefined
        : startConsumer(
              redis,
              { tasks: httpTasks(env), manifests, log: app.log },
              env,
              // Two boxes sharing a consumer name share their claims, so one would acknowledge work
              // the other is still doing.
              env.BUILDER_NAME === '' ? hostname() : env.BUILDER_NAME,
          );

if (redis === undefined) app.log.error('no build stream is attached; nothing will be claimed');
if (env.GAMES_BUCKET === undefined) app.log.error('no games bucket is attached; builds will fail');

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

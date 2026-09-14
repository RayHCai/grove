import { buildApp } from './app.js';
import { httpBuilder } from './builder.js';
import { readEnv } from './env.js';
import { httpFleet } from './fleet.js';
import { unattachedRecords } from './records.js';

const env = readEnv();
// Named rather than defaulted: the accounts and projects store is the seam with nothing behind it,
// and every sign-in answers 401 until something is.
const app = await buildApp(env, unattachedRecords, httpFleet(env), httpBuilder(env));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void app.close().then(() => process.exit(0));
    });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });

import { buildApp } from './app.js';
import { readEnv } from './env.js';

const env = readEnv();
const app = await buildApp(env);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void app.close().then(() => process.exit(0));
    });
}

await app.listen({ host: env.GAME_BUILDER_HOST, port: env.GAME_BUILDER_PORT });

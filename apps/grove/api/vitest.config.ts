import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Well past anything here measures. What it buys is the first case in each file: building a
        // Fastify app registers a dozen plugins and compiles a schema per route, and run beside the
        // rest of the repo that cold start alone can pass five seconds — which at the default makes
        // whether this suite is green depend on what else is running.
        testTimeout: 30_000,
    },
});

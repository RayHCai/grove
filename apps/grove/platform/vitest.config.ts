import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // .tsx as well as .ts: a component test is the ordinary case in a React app, and a glob
        // that cannot match one makes it invisible to the runner rather than failing.
        include: ['tests/**/*.test.{ts,tsx}'],
        // vitest defaults to node, where `document` does not exist and mounting anything throws.
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        // Run beside the rest of the repo, the first case in a file to touch the DOM can pass five
        // seconds on its own, which at the default makes whether this suite is green depend on
        // what else is running.
        testTimeout: 30_000,
    },
});

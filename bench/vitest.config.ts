import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // The meters need a forced collection to establish a baseline, and `global.gc` exists only
        // under this flag — without it every measurement here would start on an unswept heap.
        pool: 'forks',
        execArgv: ['--expose-gc'],
        // The default semi-space, deliberately: these tests assert that a heavy window is REFUSED as
        // inexact, which is only true at a heap size a window can actually fill.
        // A scenario smoke test steps thousands of ticks; the 5s default is a unit-test budget.
        testTimeout: 120_000,
    },
});

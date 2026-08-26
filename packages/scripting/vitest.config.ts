import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // The pipeline spawns a compiler and a bundler per case; the default 5s is not enough.
        testTimeout: 120_000,
    },
});

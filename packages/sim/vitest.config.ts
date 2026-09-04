import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Thousands of entities through core's O(n²) contact pass overrun the default 5s under load.
        testTimeout: 60_000,
    },
});

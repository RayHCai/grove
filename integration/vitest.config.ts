import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // A soak runs thousands of ticks across several sessions; the 5s default is a unit-test
        // budget and would fail on cadence rather than on a defect.
        testTimeout: 120_000,
    },
});

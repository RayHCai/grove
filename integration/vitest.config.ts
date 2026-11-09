import { defineConfig } from 'vitest/config';
import { standardDecorators } from '../scripts/vitest-decorators.mjs';

export default defineConfig({
    plugins: [standardDecorators()],
    test: {
        include: ['tests/**/*.test.ts'],
        // A soak runs thousands of ticks across several sessions; the 5s default is a unit-test
        // budget and would fail on cadence rather than on a defect.
        testTimeout: 120_000,
    },
});

import { defineConfig } from 'vitest/config';
import { standardDecorators } from '../../scripts/vitest-decorators.mjs';

export default defineConfig({
    plugins: [standardDecorators()],
    test: {
        include: ['tests/**/*.test.ts'],
        // Thousands of entities through core's O(n²) contact pass overrun the default 5s under
        // load.
        testTimeout: 60_000,
    },
});

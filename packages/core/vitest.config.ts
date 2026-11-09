import { defineConfig } from 'vitest/config';
import { standardDecorators } from '../../scripts/vitest-decorators.mjs';

export default defineConfig({
    plugins: [standardDecorators()],
    test: {
        include: ['tests/**/*.test.ts'],
    },
});

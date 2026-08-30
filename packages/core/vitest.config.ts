import { defineConfig } from 'vitest/config';

// Tests run against the tsc-built `dist`, not source: core is standard-decorators-only, and the
// Rolldown-Vite (oxc) transform passes TC39 standard decorators through untransformed, which Node
// cannot parse. The `test` script runs `tsc -b` first, so decorator-bearing fixtures under
// `src/testkit` are lowered by the real build compiler and imported here as compiled `.js`. Test
// files themselves carry no decorator syntax.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
    },
});

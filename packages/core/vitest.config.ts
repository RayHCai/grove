import { defineConfig } from 'vitest/config';

// Tests run against the tsc-built `dist`: the oxc transform passes TC39 decorators through
// untransformed, which Node cannot parse. `test` runs `tsc -b` first, so fixtures arrive lowered.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
    },
});

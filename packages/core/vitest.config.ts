import { defineConfig } from 'vitest/config';

// Decorated fixtures are imported from the tsc-built `dist`, since the test transform leaves TC39
// decorators unlowered and Node cannot parse them; `test` runs `tsc -b` first to keep them current.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
    },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // The slot-table property run sweeps every live handle after each of 6000 steps, which clears
        // the default 5s on this machine and does not on a shared runner. A property suite that fails
        // on how fast the box is teaches the reader to re-run it, not to read it.
        testTimeout: 60_000,
    },
});

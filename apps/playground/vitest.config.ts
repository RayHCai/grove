import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // The round tests drive the real wire for 3200-odd beats apiece: 45 seconds of game clock at
        // 60 Hz. That is well inside a second on an idle machine and nowhere near it on a loaded CI
        // runner sharing three cores with every other package's suite, which the 5s default then
        // reads as a hang. Sized like packages/sim, which does the same work.
        testTimeout: 60_000,
    },
});

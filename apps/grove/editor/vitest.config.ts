import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // The documents a build emits are the build's to name; a suite hands the host its own.
        alias: {
            'virtual:grove-preview': fileURLToPath(
                new URL('./tests/preview-documents.ts', import.meta.url),
            ),
        },
    },
    test: {
        // .tsx as well as .ts: a component test is the ordinary case in a React app, and a glob
        // that cannot match one makes it invisible to the runner rather than failing.
        include: ['tests/**/*.test.{ts,tsx}'],
        // vitest defaults to node, where `document` does not exist and mounting anything throws.
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
    },
});

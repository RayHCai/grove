import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5176,
        // Fail loudly rather than silently picking another port — an app on an unexpected port is
        // worse than one that did not start, because the others are configured to dial this one.
        strictPort: true,
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
    },
});

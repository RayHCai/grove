import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        // Fail loudly rather than silently picking another port — a harness on an unexpected
        // port is worse than one that did not start.
        strictPort: true,
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
    },
});

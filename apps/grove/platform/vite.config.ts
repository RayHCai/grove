import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5175,
        // Fail loudly rather than silently picking another port — an app on an unexpected port is
        // worse than one that did not start, because the others are configured to dial this one.
        strictPort: true,
        // A bind mount delivers no inotify events, so the watcher inside a container is put on a
        // timer rather than silently never firing.
        ...(process.env.VITE_POLL === '1' ? { watch: { usePolling: true, interval: 300 } } : {}),
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
    },
});

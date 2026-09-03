import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const SLUGS = ['pixel'];

const page = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    root: 'src',
    server: {
        // 5173 belongs to the playground harness; fail loudly rather than shift ports.
        port: 5180,
        strictPort: true,
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: page('src/index.html'),
                ...Object.fromEntries(SLUGS.map((slug) => [slug, page(`src/pages/${slug}.html`)])),
            },
        },
    },
});

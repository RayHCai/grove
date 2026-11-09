import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { gameHosts, socketSources } from './src/servers';

/** The policy a built page carries: its own code, a verified bundle's blob, and the fleet's sockets. */
function contentSecurityPolicy(hosts: readonly string[] | undefined): string {
    return [
        "default-src 'self'",
        // A verified bundle is imported from a blob; the renderer loads pixi's no-eval shader syncs.
        "script-src 'self' blob:",
        // Bundles and art come from an edge this build is never told; only sockets are held to a list.
        ['connect-src', "'self'", 'https:', ...socketSources(hosts)].join(' '),
        "img-src 'self' blob: data: https:",
        "media-src 'self' blob: data: https:",
        "font-src 'self' data: https:",
        "style-src 'self' https://fonts.googleapis.com",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** A meta tag rather than a header, since a static host is told nothing but the files. */
function contentSecurity(): Plugin {
    let policy = '';
    return {
        name: 'grove-player-csp',
        // A dev server's React refresh preamble is an inline script, which this policy refuses.
        apply: 'build',
        configResolved(config) {
            policy = contentSecurityPolicy(gameHosts(config.env['VITE_GAME_HOSTS']));
        },
        transformIndexHtml: () => [
            {
                tag: 'meta',
                attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
                injectTo: 'head-prepend',
            },
        ],
    };
}

export default defineConfig({
    plugins: [react(), contentSecurity()],
    server: {
        port: 5177,
        // Fail loudly rather than silently picking another port; an app on an unexpected port is
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

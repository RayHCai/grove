import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_ENTRY = fileURLToPath(new URL('./dist/server/main.js', import.meta.url));

/**
 * The one live child, parked on the global rather than a module variable: Vite re-evaluates this
 * config in the SAME process, resetting module state but not the child whose port it still holds.
 */
const CHILD_KEY = Symbol.for('@platform/playground:game-server');
const slot = globalThis as unknown as Record<symbol, ChildProcess | undefined>;

/**
 * Runs the game server beside the dev server, as its own process: the game uses core's decorators
 * and only `tsc` lowers those, so the child is `tsconfig.server.json`'s output.
 */
function gameServer(): Plugin {
    return {
        name: 'playground-game-server',
        apply: 'serve',
        configureServer(server) {
            if (!existsSync(SERVER_ENTRY)) {
                server.config.logger.error(
                    `[game] ${SERVER_ENTRY} is missing — run \`tsc -p tsconfig.server.json\` (the \`dev\` script does).`,
                );
                return;
            }

            slot[CHILD_KEY]?.kill();
            const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: 'inherit' });
            slot[CHILD_KEY] = child;

            child.on('exit', (code) => {
                if (slot[CHILD_KEY] === child) slot[CHILD_KEY] = undefined;
                if (code !== 0 && code !== null) {
                    server.config.logger.error(`[game] server exited with code ${code}`);
                }
            });

            const stop = (): void => {
                child.kill();
            };
            server.httpServer?.once('close', stop);
            process.once('exit', stop);
        },
    };
}

export default defineConfig({
    plugins: [react(), gameServer()],
    server: {
        port: 5173,
        // Fail loudly rather than silently picking another port — a harness on an unexpected
        // port is worse than one that did not start.
        strictPort: true,
    },
    build: {
        // `dist/` is shared with the server project's output, so Vite owns a subdirectory of it —
        // `emptyOutDir` empties whatever it is pointed at, and `dist` would take the server with
        // it.
        outDir: 'dist/client',
        emptyOutDir: true,
        sourcemap: true,
    },
});

// The composition root, which is now three lines of policy and one call.
//
// Everything this file used to do — parse a port, stand up a listener, build a transport per socket
// in the right order, accept it under a resolved identity, drive `pump` rather than `start`, close
// the world before the socket — belongs to `@platform/glue/node`. What is left is the three things
// that are genuinely this deployment's: where it listens, where it saves, and who it believes a
// socket is.

import type { IncomingMessage } from 'node:http';
import { fileKVStore, listenOn } from '@platform/glue/node';
import { DEFAULT_GAME_PORT } from '../hosting.js';
import { PROJECT } from '../project.js';
import { createGameInstance } from './host.js';

const raw = process.env['GAME_PORT'];
const port = raw === undefined ? DEFAULT_GAME_PORT : Number(raw);

/** The one console this process writes to, so the lint exemption is a single line wide. */
// oxlint-disable-next-line no-console
const log = (line: string): void => void console.log(`[game] ${line}`);

/**
 * Who the server should think this socket is — a toy's answer, taken from the peer's own query.
 *
 * A real host reads a cookie or an auth header here. This one believes the claim, so anyone may
 * name themselves anyone; the server keys persisted `@serverState` by it, so on a real deployment
 * that is a read-and-overwrite of another player's save. Kept visible here rather than on the wire,
 * which is the whole reason identity is the host's to resolve and never a frame's to carry.
 */
function playerIdentity(request: IncomingMessage): string {
    const claimed = new URL(request.url ?? '/', 'ws://placeholder').searchParams.get('player');
    return claimed !== null && claimed !== '' ? claimed : `anon-${anonCount++}`;
}

let anonCount = 0;

const game = listenOn(
    createGameInstance({
        kv: fileKVStore(process.env['GAME_STATE_FILE'] ?? 'dist/state.json'),
        // A handler the breaker gave up on after a hundred consecutive throws. Deliberately not an
        // envelope: a disabled handler is something whoever runs the server has to see.
        onBreakerTrip: (trip) => log(`breaker disabled ${trip.scriptClass}.${trip.method}`),
    }),
    { port, identify: playerIdentity, onLog: log },
);

game.listening.then(
    () => {
        const { simRate, sendRate } = PROJECT.settings;
        log(`ws://localhost:${port} — ${simRate}Hz sim, ${sendRate} sends/s`);
    },
    (cause: Error) => {
        log(`could not listen on ${port}: ${cause.message}`);
        process.exitCode = 1;
        void game.close();
    },
);

// The signal wiring is the APPLICATION's, never the package's: a library that installed these would
// fight whatever else the process already does about shutdown.
const shutdown = (): void => void game.close().then(() => process.exit(process.exitCode ?? 0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

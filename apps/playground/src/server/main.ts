// The composition root: one `GameServer`, one WebSocket listener, one process.
//
// `@platform/server` never opens a socket and `@platform/transport` is a leaf with no dependencies,
// so standing up a listener and handing it a transport per connection is this file's whole job.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { GameServer } from '@platform/server';
import type { TransportError } from '@platform/transport';
import { webSocketTransport } from '@platform/transport/websocket';
import { DEFAULT_GAME_PORT } from '../shared.js';
import { SEND_RATE, SIM_RATE, serverConfig } from './config.js';
import { fileKVStore } from './kv.js';

const raw = process.env['GAME_PORT'];
const port = raw === undefined ? DEFAULT_GAME_PORT : Number(raw);
if (!Number.isInteger(port) || port <= 0) {
    throw new RangeError(`GAME_PORT must be a positive integer, received ${raw}`);
}

/** The one console this process writes to, so the lint exemption is a single line wide. */
// oxlint-disable-next-line no-console
const log = (line: string): void => void console.log(line);

/**
 * Who the server should think this socket is — a toy's answer, taken from the peer's own query.
 *
 * A real host reads a cookie or an auth header here. This one believes the claim, so anyone may
 * name themselves anyone; the server keys persisted `@serverState` by it, so on a real deployment
 * that is a read-and-overwrite of another player's save. Kept visible here rather than on the wire,
 * which is the whole reason the server takes identity from its host and never from a frame.
 */
function playerIdentity(request: IncomingMessage): string {
    const claimed = new URL(request.url ?? '/', 'ws://placeholder').searchParams.get('player');
    return claimed !== null && claimed !== '' ? claimed : `anon-${anonCount++}`;
}

let anonCount = 0;

// The store is injected HERE and not in `serverConfig()`, which describes the world rather than how
// it is hosted: the session suite boots the same config over a loopback pair and must not write to
// anyone's disk to do it.
const statePath = process.env['GAME_STATE_FILE'] ?? 'dist/state.json';
const server = new GameServer({ config: { ...serverConfig(), kv: fileKVStore(statePath) } });
const wss = new WebSocketServer({ port });

wss.on('listening', () => {
    log(`[game] ws://localhost:${port} — ${SIM_RATE}Hz sim, ${SEND_RATE} sends/s`);
});

wss.on('error', (cause: Error) => {
    log(`[game] listener failed: ${cause.message}`);
    process.exitCode = 1;
    shutdown();
});

wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    // Synchronously, before any await: the transport registers the socket's message listener in its
    // constructor and `ws` resumes the stream on the next tick, so a frame that arrives before that
    // listener exists is simply gone — retention covers a late handler, not a late transport.
    try {
        const transport = webSocketTransport(socket, {
            onError: (error: TransportError) => {
                log(`[game] connection error (${error.code}): ${error.message}`);
            },
        });
        // `null` means refused, and the server has already closed the transport.
        if (server.accept(transport, playerIdentity(request)) === null) {
            log('[game] refused a connection');
        }
    } catch (cause) {
        log(`[game] could not accept a connection: ${(cause as Error).message}`);
        socket.close(1011);
    }
});

/**
 * The server is pumped here rather than self-driven through `GameServer.start()`.
 *
 * `start()` drives the Driver directly, which skips `GameServer.pump`'s join-deadline sweep — so a
 * connection that opens and never joins would hold one of the 32 unjoined slots for good. Pumping
 * keeps that sweep, and gives the world a real wall clock instead of the interval's own cadence.
 */
const tick = setInterval(() => {
    server.pump(Date.now() / 1000);
}, 1000 / SIM_RATE);

let closing = false;

function shutdown(): void {
    if (closing) return;
    closing = true;
    clearInterval(tick);
    server.close();
    wss.close(() => process.exit(process.exitCode ?? 0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The Node host: a WebSocket listener in front of a game instance.
//
// It installs no signal handlers — a library that called `process.on('SIGINT')` would fight whatever
// the application already does about shutdown, so `close()` is exposed and the wiring is the app's.

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { TransportError } from '@platform/transport';
import { webSocketTransport } from '@platform/transport/websocket';
import type { GameInstance } from '../instance.js';

/** Where to bind, and how to decide who a socket is. */
export interface ListenOptions {
    /** Bound when no `server` is supplied. */
    port?: number;
    /** An existing HTTP server to share, for a game socket behind the same origin as a page. */
    server?: HttpServer;
    /**
     * Who the game should think this socket is.
     *
     * Resolved from the upgrade request and NEVER from a frame, which is the whole reason the
     * server takes identity from its host: whatever this returns is what the game trusts, and it
     * reaches every other peer as `player.id`. Returning `undefined` admits the connection
     * anonymously, and nothing it writes survives the process.
     */
    identify?: (request: IncomingMessage) => string | undefined;
    /** Diagnostics. Absent, a refused or broken connection is silent. */
    onLog?: (line: string) => void;
}

/** A listening instance, and the one verb that takes it down. */
export interface ServedGame {
    readonly instance: GameInstance;
    readonly wss: WebSocketServer;
    /** Resolves once the socket is bound; rejects if it could not be. */
    readonly listening: Promise<void>;
    close(): Promise<void>;
}

/**
 * Puts a WebSocket listener in front of an instance that is already built.
 *
 * The instance is started here rather than by the caller, so the world is ticking before the first
 * socket can arrive.
 */
export function listenOn(instance: GameInstance, opts: ListenOptions): ServedGame {
    const { port, server, identify, onLog } = opts;
    if (port === undefined && server === undefined) {
        throw new TypeError('listenOn needs a port to bind or an http server to share');
    }
    if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
        throw new RangeError(`port must be a positive integer, received ${String(port)}`);
    }

    const log = onLog ?? ((): void => {});
    instance.start();
    const wss = new WebSocketServer(server === undefined ? { port: port! } : { server });

    const listening = new Promise<void>((resolve, reject) => {
        // A shared http server is already listening, so no event is coming for it.
        if (server !== undefined) {
            resolve();
            return;
        }
        wss.once('listening', () => resolve());
        wss.once('error', (cause: Error) => reject(cause));
    });

    wss.on('error', (cause: Error) => {
        log(`listener failed: ${cause.message}`);
    });

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
        // Synchronously, before any await: `ws` resumes the stream on the next tick, so a frame
        // arriving before the transport's own listener exists is simply gone.
        try {
            const transport = webSocketTransport(socket, {
                onError: (error: TransportError) => {
                    log(`connection error (${error.code}): ${error.message}`);
                },
            });
            // `null` means refused, and the instance has already closed the transport.
            if (instance.accept(transport, identify?.(request)) === null) {
                log('refused a connection');
            }
        } catch (cause) {
            log(
                `could not accept a connection: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            socket.close(1011);
        }
    });

    return {
        instance,
        wss,
        listening,
        close: () =>
            new Promise<void>((resolve) => {
                // The world first: a socket closed while the instance still ticks would let the
                // next pump broadcast to a connection nothing is listening on.
                instance.close();
                wss.close(() => resolve());
            }),
    };
}

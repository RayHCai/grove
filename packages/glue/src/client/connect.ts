// The deployment half: a WebSocket in front of a session that does not exist yet.
//
// `listenOn` is the shape this mirrors — the socket layer as a function beside the instance rather
// than inside it, so the instance itself stays reachable over a loopback pair with no socket.

import { connectWebSocket } from '@platform/transport/websocket';
import type { TransportError } from '@platform/transport';
import { ClientInstance } from './instance.js';
import type { ClientInstanceOptions } from './instance.js';

/** Where to dial, and how to give up on it. */
export interface ConnectOptions extends Omit<ClientInstanceOptions, 'transport'> {
    url: string;
    /**
     * Abandons a dial that is no longer wanted.
     *
     * The reason this is not left to the caller: a dial resolves on its own schedule, so a host that
     * unmounted while it was in flight holds no session to close and the socket becomes a player
     * that never leaves. Aborted, the transport is closed here and nothing is constructed.
     */
    signal?: AbortSignal;
    /** Diagnostics from the socket itself. Absent, a broken connection is silent. */
    onError?: (error: TransportError) => void;
}

/**
 * Dials, composes a session over the socket, and joins.
 *
 * Started, for the reason `listenOn` starts the world it is put in front of: this is the socket
 * layer, and a caller that reached for it wants the session running. A host that needs to hold a
 * built-but-unjoined session builds `ClientInstance` itself and calls `start()` when it is ready.
 */
export async function connectTo(opts: ConnectOptions): Promise<ClientInstance> {
    const { url, signal, onError, ...forwarded } = opts;
    signal?.throwIfAborted();

    const transport = await connectWebSocket(url, onError === undefined ? {} : { onError });
    // Resolved into a host that has since given up: close the socket rather than leaving it open
    // behind a session nobody holds.
    if (signal?.aborted === true) {
        transport.close();
        signal.throwIfAborted();
    }

    const instance = new ClientInstance({ ...forwarded, transport }).start();
    // The signal owns the session from here. An abort landing between this promise resolving and
    // the caller's own continuation is a window no caller can close for itself — it does not hold
    // the instance yet — so the session is closed from the signal instead. `close()` is idempotent,
    // so a host that also closes its own is no different.
    signal?.addEventListener('abort', () => instance.close(), { once: true });
    return instance;
}

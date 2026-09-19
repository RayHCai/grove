// The socket layer as a function beside the instance, so the instance stays loopback-drivable.

import { connectWebSocket } from '@platform/transport/websocket';
import type { ConnectWebSocketOptions } from '@platform/transport/websocket';
import type { TransportError } from '@platform/transport';
import { ClientInstance } from './instance.js';
import type { ClientInstanceOptions } from './instance.js';

/** Where to dial, and how to give up on it. */
export interface ConnectOptions extends Omit<ClientInstanceOptions, 'transport'> {
    url: string;
    /**
     * Abandons a dial that is no longer wanted. A dial resolves on its own schedule, so a host
     * that unmounted mid-flight has no session to close and the socket never leaves.
     */
    signal?: AbortSignal;
    /** Diagnostics from the socket itself. Absent, a broken connection is silent. */
    onError?: (error: TransportError) => void;
    /** Offered at the upgrade: a browser dial sets no header, so a credential has no other ride. */
    protocols?: string[];
}

/**
 * Dials, composes a session over the socket, and joins. Started, since a caller reaching for
 * the socket layer wants it running; hold one unjoined by building `ClientInstance` instead.
 */
export async function connectTo(opts: ConnectOptions): Promise<ClientInstance> {
    const { url, signal, onError, protocols, ...forwarded } = opts;
    signal?.throwIfAborted();

    // Built key by key, since an explicit undefined is not the same as an absent option here.
    const dialOpts: ConnectWebSocketOptions = {};
    if (onError !== undefined) dialOpts.onError = onError;
    if (protocols !== undefined) dialOpts.protocols = protocols;
    const transport = await connectWebSocket(url, dialOpts);
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

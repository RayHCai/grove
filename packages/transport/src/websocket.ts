// Two doors because a client dials and a server is handed a socket its listener already accepted;
// the dial fires once and never retries, so reconnection belongs to whoever owns the session.

import type { Codec } from './codec.js';
import { MAX_FRAME_BYTES, jsonCodec } from './codec.js';
import type { TransportErrorCode } from './errors.js';
import { TransportError, transportError } from './errors.js';
import { FrameInbox, retentionOverflowMessage, validateRetentionCap } from './inbox.js';
import { DEFAULT_MAX_RETAINED_BYTES } from './transport.js';
import type {
    ConnectOptions,
    EncodedFrame,
    Frame,
    Message,
    TimerSource,
    Transport,
    TransportOptions,
} from './transport.js';

/**
 * Declared rather than imported, since `src/` pulls in neither `node` nor `DOM` types — and only
 * the members named here are touched, so one file compiles against all three implementations.
 */
declare const WebSocket: { new (url: string, protocols?: string[]): WebSocketLike };
declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (handle: unknown) => void;

/**
 * The WebSocket surface this backend uses; every member is common to browser, Node and `ws`.
 * `addEventListener`, not an `onmessage` assignment, which would replace the root's listener.
 */
export interface WebSocketLike {
    /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED — fixed by the standard. */
    readonly readyState: number;
    /** Bytes sitting in the socket's own send buffer, which is what the outbound cap reads. */
    readonly bufferedAmount: number;
    /**
     * Written, never read. `unknown` because the three implementations declare three different
     * unions and `'arraybuffer'` is the only member of all of them.
     */
    binaryType?: unknown;
    /**
     * `Uint8Array<ArrayBuffer>` rather than `Frame`'s plain `Uint8Array`: a bare one also admits a
     * `SharedArrayBuffer` backing, so the wider type makes a real socket unassignable here.
     */
    send(data: string | Uint8Array<ArrayBuffer>): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Options common to both doors. */
export interface WebSocketOptions extends TransportOptions {
    /**
     * Where a coded failure goes, since `Transport` has no error channel: a `decode` rejection, a
     * stalled peer, silence, or an abnormal close. Without it a hostile peer and a quit look alike.
     */
    onError?: (error: TransportError) => void;
    /**
     * Cap on the socket's own unsent bytes before the connection closes.
     * `maxRetainedBytes` bounds what arrived unread; this bounds what would not move.
     */
    maxBufferedBytes?: number;
    /** The heartbeat's scheduling seam; defaults to a real-time source. */
    timer?: TimerSource;
}

/** Options for the dial. */
export interface ConnectWebSocketOptions extends ConnectOptions, WebSocketOptions {
    /** Subprotocols offered at the upgrade; a browser dial sets no header. */
    protocols?: string[];
    /** The socket constructor, defaulting to the global `WebSocket`; a seam, so `ws` can pass. */
    createSocket?: (url: string, protocols?: string[]) => WebSocketLike;
}

/** `readyState` values, named here so a supplied socket need carry no statics. */
const OPEN = 1;

/**
 * Close codes this end reads or writes. `close()` always writes `NORMAL_CLOSURE`: a close code
 * is not a protocol channel here. Inbound, `GOING_AWAY` is as clean as normal — a tab leaving.
 */
const NORMAL_CLOSURE = 1000;
const GOING_AWAY = 1001;

/** Cap on unsent bytes, sized off the frame cap: more means a peer that stopped reading. */
const DEFAULT_MAX_BUFFERED_BYTES = MAX_FRAME_BYTES;

/** Milliseconds between silence checks, and how many silent ones close it. Three ≈ 10–15 s. */
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;

/** Options resolved and validated once, so neither door repeats the defaulting. */
interface Resolved {
    readonly codec: Codec;
    readonly maxRetainedBytes: number;
    readonly maxBufferedBytes: number;
    readonly report: ((error: TransportError) => void) | undefined;
    readonly timer: TimerSource;
}

const realTimer: TimerSource = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
        clearInterval(handle);
    },
};

function resolve(opts: WebSocketOptions | undefined): Resolved {
    const maxRetainedBytes = opts?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
    const maxBufferedBytes = opts?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

    validateRetentionCap(maxRetainedBytes);
    if (!(maxBufferedBytes > 0)) {
        transportError(
            'invalid-option',
            `maxBufferedBytes must be a positive byte count; received ${String(maxBufferedBytes)}.`,
        );
    }

    return {
        codec: opts?.codec ?? jsonCodec,
        maxRetainedBytes,
        maxBufferedBytes,
        report: opts?.onError,
        timer: opts?.timer ?? realTimer,
    };
}

/**
 * Reads a frame off a message event. `binaryType` is `'arraybuffer'`, so a conforming socket
 * hands over a string or a view — never a `Blob`, which would have to be awaited, reordering.
 */
function frameOf(event: unknown): Frame | undefined {
    const data = (event as { data?: unknown } | null)?.data;
    if (typeof data === 'string') return data;
    // Node's Buffer passes the first test, `ws` and the browsers under 'arraybuffer' the second.
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return undefined;
}

function closeCodeOf(event: unknown): number | undefined {
    const code = (event as { code?: unknown } | null)?.code;
    return typeof code === 'number' ? code : undefined;
}

/**
 * One end of one established WebSocket: its events, its inbox, and the silence timer.
 * Everything but the five `Transport` methods is `#`-private, which a `private` would not be.
 */
class WebSocketEnd implements Transport {
    readonly #socket: WebSocketLike;
    readonly #opts: Resolved;
    readonly #inbox: FrameInbox;

    /** `'closing'` is "we asked", `'closed'` is "it is over"; one flag for both double-reports. */
    #state: 'open' | 'closing' | 'closed' = 'open';
    /** One cause per connection: an error event and the abnormal close behind it are one fault. */
    #causeReported = false;
    /** Reported once rather than per frame: the frames were dropped, so repeating is not news. */
    #overflowReported = false;

    #heartbeat: unknown;
    /** Whether this heartbeat window has seen anything inbound at all. */
    #silent = true;
    #missed = 0;

    constructor(socket: WebSocketLike, opts: Resolved) {
        this.#socket = socket;
        this.#opts = opts;
        this.#inbox = new FrameInbox({
            codec: opts.codec,
            maxRetainedBytes: opts.maxRetainedBytes,
            onOverflow: (retained, bytes) => {
                // The connection survives: the wiring bug is above the transport, and killing a
                // live socket would not fix it.
                if (this.#overflowReported) return;
                this.#overflowReported = true;
                opts.report?.(
                    new TransportError(
                        'retention-overflow',
                        retentionOverflowMessage(
                            retained,
                            bytes,
                            opts.maxRetainedBytes,
                            'life of the connection. Register onMessage as soon as the transport exists',
                        ),
                    ),
                );
            },
            onDecodeFailure: (error) => {
                // Unlike loopback, where the sender's own `encode` produced the frame, this one
                // came from a peer: a rejection is the peer's bug, so it is reported and the
                // connection closes rather than throwing into a socket event nothing can catch. An
                // error that is not a `TransportError` is our defect and propagates.
                if (!(error instanceof TransportError)) throw error;
                this.#reportCause(error);
                this.close();
            },
        });

        socket.binaryType = 'arraybuffer';
        socket.addEventListener('message', (event) => this.#onSocketMessage(event));
        socket.addEventListener('close', (event) => this.#onSocketClose(event));
        socket.addEventListener('error', () => this.#onSocketError());

        this.#heartbeat = opts.timer.setInterval(() => this.#check(), HEARTBEAT_INTERVAL_MS);
    }

    send(message: Message): void {
        // Encoded BEFORE the closed check, so a bad payload is the sender's bug either way rather
        // than timing-dependent on whether the socket had dropped yet.
        this.sendEncoded(this.#opts.codec.encode(message));
    }

    sendEncoded(frame: EncodedFrame): void {
        // A peer that dropped mid-fan-out must not abort the fan-out over the live ones.
        if (this.#state !== 'open' || this.#socket.readyState !== OPEN) return;

        if (this.#socket.bufferedAmount > this.#opts.maxBufferedBytes) {
            this.#fail(
                'send-buffer-overflow',
                `The socket holds ${this.#socket.bufferedAmount} unsent bytes, over the ${this.#opts.maxBufferedBytes}-byte cap, so the peer has stopped draining. Holding a backlog for it costs memory that is not coming back, so the connection is closed instead.`,
            );
            return;
        }

        // Narrowed, not validated: no codec mints a frame over a `SharedArrayBuffer`, which is the
        // only thing `Frame` admits and `send` does not.
        this.#socket.send(frame as string | Uint8Array<ArrayBuffer>);
    }

    onMessage(handler: (message: Message) => void): () => void {
        return this.#inbox.registerMessage(handler);
    }

    onClose(handler: () => void): () => void {
        return this.#inbox.registerClose(handler);
    }

    close(): void {
        if (this.#state !== 'open') return;
        this.#state = 'closing';
        this.#stopHeartbeat();
        // No marker is queued here: the socket's own close event is the single source of one. That
        // event always arrives, because this end is only ever built around an OPEN socket it is
        // already listening to, and the standard queues it as a task rather than firing it inline —
        // which is what keeps `onClose` out of this call's own stack.
        this.#socket.close(NORMAL_CLOSURE);
    }

    #onSocketMessage(event: unknown): void {
        // Anything at all proves the peer is alive, a frame this end will refuse included.
        this.#silent = false;

        const frame = frameOf(event);
        if (frame === undefined) {
            this.#fail(
                'malformed-frame',
                'The socket delivered a message that is neither a string nor bytes. binaryType is set to "arraybuffer" at construction, so this is a socket implementation that ignored it or a peer speaking something other than this wire.',
            );
            return;
        }

        this.#receive(frame);
    }

    #receive(frame: Frame): void {
        // The peer does not learn of a local close until its own socket reports one, and in that
        // window its frames would otherwise queue into an inbox nothing will ever drain.
        if (this.#state !== 'open') return;

        this.#inbox.enqueue(frame);
        // The event loop is the pump here, so a drain follows every arrival — which is why a
        // backlog behind a live handler cannot build up on this wire.
        this.#inbox.drain();
    }

    #onSocketClose(event: unknown): void {
        const code = closeCodeOf(event);
        // Reported only when this end did not ask: after a local `close()` an implementation may
        // still report 1006, and blaming the peer for our own teardown would be a false positive.
        if (code !== undefined && code !== NORMAL_CLOSURE && code !== GOING_AWAY) {
            this.#reportCause(
                new TransportError(
                    'socket-error',
                    `The connection closed with code ${code}, which neither end asked for — 1006 is a link that dropped without a close frame. onClose alone cannot tell this from a clean quit.`,
                ),
            );
        }

        this.#state = 'closed';
        this.#stopHeartbeat();
        // Rides the FIFO behind every frame already queued, so a handler registered later still
        // sees them in order and learns of the close last.
        this.#inbox.queueClose();
        this.#inbox.drain();
    }

    #onSocketError(): void {
        // The close event follows an error on every implementation, and it is what fires `onClose`;
        // this only adds the cause. Most implementations put no message on the event.
        this.#reportCause(
            new TransportError(
                'socket-error',
                'The WebSocket reported an error; the close that follows it is not a clean one.',
            ),
        );
    }

    /**
     * Reports the cause of one connection's death, at most once.
     * A browser's `error` then 1006 close are two views of one fault; after `close()`, none.
     */
    #reportCause(error: TransportError): void {
        if (this.#causeReported || this.#state !== 'open') return;
        this.#causeReported = true;
        this.#opts.report?.(error);
    }

    /** One silence window. Counts inbound frames, sends nothing — the wire has no ping to send. */
    #check(): void {
        if (!this.#silent) {
            this.#silent = true;
            this.#missed = 0;
            return;
        }

        this.#missed++;
        if (this.#missed < MAX_MISSED_HEARTBEATS) return;

        this.#fail(
            'heartbeat-timeout',
            `Nothing arrived in ${MAX_MISSED_HEARTBEATS} consecutive ${HEARTBEAT_INTERVAL_MS} ms windows. Both directions carry unprompted traffic, so this is a half-open socket — a killed tab or a yanked cable — that TCP has not given up on yet and never may.`,
        );
    }

    #stopHeartbeat(): void {
        if (this.#heartbeat === undefined) return;
        this.#opts.timer.clearInterval(this.#heartbeat);
        // Cleared rather than left set, because the closure holds this end for as long as it lives.
        this.#heartbeat = undefined;
    }

    /** Reports a coded cause the seam cannot carry, then closes — ordered so the cause survives. */
    #fail(code: TransportErrorCode, message: string): void {
        this.#reportCause(new TransportError(code, message));
        this.close();
    }
}

/**
 * Dials `url` and resolves once the socket is OPEN — the networked `Connect`.
 * Rejects with `connect-failed` before OPEN; after it, faults go to `onError` instead.
 */
export function connectWebSocket(url: string, opts?: ConnectWebSocketOptions): Promise<Transport> {
    // Resolved before the socket is created, so a bad option rejects nothing and opens nothing.
    const resolved = resolve(opts);
    const createSocket =
        opts?.createSocket ??
        ((target: string, protocols?: string[]) => new WebSocket(target, protocols));

    return new Promise<Transport>((fulfil, refuse) => {
        let socket: WebSocketLike;
        try {
            // One argument when nothing is offered, so a factory declaring only a url sees only
            // one.
            socket =
                opts?.protocols === undefined
                    ? createSocket(url)
                    : createSocket(url, opts.protocols);
        } catch (cause) {
            // A malformed URL and a missing global both land here, and both are this caller's to
            // see.
            refuse(
                new TransportError(
                    'connect-failed',
                    `Could not create a socket for ${url}: ${
                        cause instanceof Error ? cause.message : String(cause)
                    }`,
                    { cause },
                ),
            );
            return;
        }

        // All three listeners outlive the settle — the transport registers its own for the rest of
        // the connection's life, and these become no-ops rather than a second reporting path.
        let settled = false;

        socket.addEventListener('open', () => {
            if (settled) return;
            settled = true;
            fulfil(new WebSocketEnd(socket, resolved));
        });

        socket.addEventListener('error', () => {
            if (settled) return;
            settled = true;
            refuse(
                new TransportError(
                    'connect-failed',
                    `The socket for ${url} errored before it opened. A browser reports no cause for this by design, since one would leak whether the address exists.`,
                ),
            );
        });

        socket.addEventListener('close', (event) => {
            if (settled) return;
            settled = true;
            const code = closeCodeOf(event);
            refuse(
                new TransportError(
                    'connect-failed',
                    `The socket for ${url} closed before it opened${code === undefined ? '' : ` (code ${code})`}.`,
                ),
            );
        });
    });
}

/**
 * Wraps a socket a listener already accepted, which is the server's door. Call it SYNCHRONOUSLY
 * in the connection handler: retention covers a late `onMessage`, not a late transport.
 */
export function webSocketTransport(socket: WebSocketLike, opts?: WebSocketOptions): Transport {
    if (socket.readyState !== OPEN) {
        transportError(
            'invalid-option',
            `webSocketTransport takes an OPEN socket (readyState ${OPEN}); received readyState ${socket.readyState}. A Transport is one end of an ESTABLISHED connection — dial with connectWebSocket, which resolves on open.`,
        );
    }
    return new WebSocketEnd(socket, resolve(opts));
}

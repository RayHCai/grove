// A Transport over one WebSocket, with two doors in because the two ends acquire their socket
// differently: a client DIALS (`connectWebSocket`, resolving only once the socket is OPEN, so a
// caller never holds an unconnected Transport) and a server is HANDED one its listener already
// accepted (`webSocketTransport`). The listener itself stays outside this package — it needs a socket
// library, and a leaf with no dependencies cannot have one.
//
// The socket is typed structurally rather than through `lib.dom` or `@types/ws`, because `src/`
// declares neither; the three implementations that matter — a browser's global `WebSocket`, Node's,
// and `ws` — agree on every member `WebSocketLike` names.
//
// Inbound is NOT pumped: the event loop delivers, so there is no `deliver()` and no `latency`. The
// queue survives anyway, because registration still races arrival, and one FIFO carrying frames and
// the close marker together is what keeps `onClose` behind every frame ahead of it however the two
// handlers were registered.
//
// The seam has no error channel, and three failures a socket produces that loopback cannot need one:
// a hostile frame that fails `decode`, a peer that stopped draining, and silence. Each arrives on a
// socket event where a throw would land somewhere nothing can catch it, so each is reported through
// `onError` and the connection closes behind it.

import type { Codec } from './codec.js';
import { MAX_FRAME_BYTES, jsonCodec } from './codec.js';
import type { TransportErrorCode } from './errors.js';
import { TransportError, transportError } from './errors.js';
import { FrameInbox, validateRetentionCap } from './inbox.js';
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
 * Declared rather than imported, since `src/` pulls in neither `node` nor `DOM` types — and only the
 * members named here are ever touched, so one file compiles against all three implementations.
 */
declare const WebSocket: { new (url: string): WebSocketLike };
declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (handle: unknown) => void;

/**
 * The WebSocket surface this backend uses. Every member is common to a browser's `WebSocket`, Node's
 * global, and `ws`.
 *
 * Event payloads are `unknown` because the three implementations hand over three different event
 * objects, and reading them defensively is honest rather than defeated. `addEventListener` rather
 * than an `onmessage` assignment: the composition root may have its own listener on the socket it
 * accepted, and an assignment would silently replace it.
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
     * `Uint8Array<ArrayBuffer>` rather than `Frame`'s plain `Uint8Array`: every socket API requires a
     * view onto a real `ArrayBuffer`, while a bare `Uint8Array` also admits a `SharedArrayBuffer`
     * backing — so the wider type makes a real socket unassignable to this interface.
     */
    send(data: string | Uint8Array<ArrayBuffer>): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Options common to both doors. */
export interface WebSocketOptions extends TransportOptions {
    /**
     * Where a coded failure goes, since `Transport` has no error channel and a socket event has no
     * catchable stack: a `decode` rejection, a stalled peer, silence, or an abnormal close. The
     * connection closes behind every one of them, so `onClose` still fires and this only adds the
     * cause — without it a hostile peer and a clean quit are the same event.
     */
    onError?: (error: TransportError) => void;
    /**
     * Cap on the socket's own unsent bytes before the connection is closed; defaults to
     * `MAX_FRAME_BYTES`.
     *
     * `maxRetainedBytes` bounds what arrived with nobody to take it; this bounds what we handed the
     * socket and it could not move. Nothing above the transport can see `bufferedAmount`, so nothing
     * above it could hold this bound.
     */
    maxBufferedBytes?: number;
    /** The heartbeat's scheduling seam; defaults to a real-time source. */
    timer?: TimerSource;
}

/** Options for the dial. */
export interface ConnectWebSocketOptions extends ConnectOptions, WebSocketOptions {
    /**
     * The socket constructor, defaulting to the global `WebSocket`.
     *
     * A seam rather than a hard reference to the global: a Node client older than the global's
     * arrival passes `ws`'s constructor here, which is also how the backend is driven under test.
     */
    createSocket?: (url: string) => WebSocketLike;
}

/** `readyState` values, named here so a socket the composition root supplied need carry no statics. */
const OPEN = 1;

/**
 * Close codes this end reads or writes.
 *
 * `close()` always writes `NORMAL_CLOSURE`: a close code is not a protocol channel here — protocol's
 * own `reject` envelope is, and it is sent ahead of the close. Inbound, `GOING_AWAY` is as clean as
 * normal, because it is what a tab navigating away sends and reporting that as a fault would make
 * every page close look hostile.
 */
const NORMAL_CLOSURE = 1000;
const GOING_AWAY = 1001;

/**
 * Cap on the socket's own unsent bytes, sized off the frame cap rather than chosen.
 *
 * A peer refuses anything larger than one frame, so a send buffer holding more than that is a peer
 * that stopped reading rather than a burst in flight.
 */
const DEFAULT_MAX_BUFFERED_BYTES = MAX_FRAME_BYTES;

/**
 * Milliseconds between silence checks, and how many consecutive silent ones close the connection.
 *
 * Nothing is SENT: protocol's nine messages are the whole wire, and a browser cannot send a
 * WebSocket ping control frame anyway. Inbound traffic is what liveness means, and both directions
 * carry it unprompted — the server sends `state` every send-tick even when both its arrays are
 * empty, the client a `time-sync` every 2 s — so an empty 5 s window is already abnormal. Three of
 * them is 10–15 s (a frame may land just before a boundary), well past the client's own 1 s stall
 * detection, so a stall is reported and resynced long before the connection is killed.
 */
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
 * Reads a frame off a message event.
 *
 * `binaryType` is set to `'arraybuffer'` at construction, so a conforming socket hands over a string
 * or one of these two views — never a `Blob`, which would have to be awaited, and awaiting reorders
 * frames.
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
 * One end of one established WebSocket. Owns the socket's events, its inbox, and the silence timer.
 *
 * Every member but the five `Transport` methods is `#`-private, so a consumer holding one end cannot
 * reach the inbox or the socket — a TypeScript `private` is erased and would not have stopped that.
 */
class WebSocketEnd implements Transport {
    readonly #socket: WebSocketLike;
    readonly #opts: Resolved;
    readonly #inbox: FrameInbox;

    #closed = false;
    /** Reported once rather than per frame: the frames were dropped, so repeating it is not news. */
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
                // The connection survives: the wiring bug is above the transport, and killing a live
                // socket would not fix it.
                if (this.#overflowReported) return;
                this.#overflowReported = true;
                opts.report?.(
                    new TransportError(
                        'retention-overflow',
                        `Retained ${retained} bytes for a handler that never registered, and this frame's ${bytes} would pass the ${opts.maxRetainedBytes}-byte cap. Frames are retained until onMessage registers, so a join sequence that throws before wiring it grows this inbox for the life of the connection. Register onMessage as soon as the transport exists, or raise maxRetainedBytes.`,
                    ),
                );
            },
            onDecodeFailure: (error) => {
                // Unlike loopback, where the sender's own `encode` produced the frame, this one came
                // from a peer: a rejection is the peer's bug, so it is reported and the connection
                // closes rather than throwing into a socket event nothing can catch. An error that is
                // not a `TransportError` is our defect and propagates.
                if (!(error instanceof TransportError)) throw error;
                opts.report?.(error);
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
        if (this.#closed || this.#socket.readyState !== OPEN) return;

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
        if (this.#closed) return;
        this.#closed = true;
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
        if (this.#closed) return;

        this.#inbox.enqueue(frame);
        // The event loop is the pump here, so a drain follows every arrival — which is why a backlog
        // behind a live handler cannot build up on this wire.
        this.#inbox.drain();
    }

    #onSocketClose(event: unknown): void {
        const code = closeCodeOf(event);
        // Reported only when this end did not ask: after a local `close()` an implementation may
        // still report 1006, and blaming the peer for our own teardown would be a false positive.
        if (!this.#closed && code !== undefined && code !== NORMAL_CLOSURE && code !== GOING_AWAY) {
            this.#opts.report?.(
                new TransportError(
                    'socket-error',
                    `The connection closed with code ${code}, which neither end asked for — 1006 is a link that dropped without a close frame. onClose alone cannot tell this from a clean quit.`,
                ),
            );
        }

        this.#closed = true;
        this.#stopHeartbeat();
        // Rides the FIFO behind every frame already queued, so a handler registered later still sees
        // them in order and learns of the close last.
        this.#inbox.queueClose();
        this.#inbox.drain();
    }

    #onSocketError(): void {
        // The close event follows an error on every implementation, and it is what fires `onClose`;
        // this only adds the cause. Most implementations put no message on the event.
        if (this.#closed) return;
        this.#opts.report?.(
            new TransportError(
                'socket-error',
                'The WebSocket reported an error; the close that follows it is not a clean one.',
            ),
        );
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

    /** Reports a coded cause the seam cannot carry, then closes. Ordered so the cause outlives it. */
    #fail(code: TransportErrorCode, message: string): void {
        this.#opts.report?.(new TransportError(code, message));
        this.close();
    }
}

/**
 * Dials `url` and resolves once the socket is OPEN — the networked `Connect`.
 *
 * Rejects with `connect-failed` if the socket errors or closes before opening, so a caller never
 * holds a `Transport` for a connection that never existed. Everything after OPEN is reported through
 * `onError` instead, because by then the promise has settled.
 */
export function connectWebSocket(url: string, opts?: ConnectWebSocketOptions): Promise<Transport> {
    // Resolved before the socket is created, so a bad option rejects nothing and opens nothing.
    const resolved = resolve(opts);
    const createSocket = opts?.createSocket ?? ((target: string) => new WebSocket(target));

    return new Promise<Transport>((fulfil, refuse) => {
        let socket: WebSocketLike;
        try {
            socket = createSocket(url);
        } catch (cause) {
            // A malformed URL and a missing global both land here, and both are this caller's to see.
            refuse(
                new TransportError(
                    'connect-failed',
                    `Could not create a socket for ${url}: ${(cause as Error).message}`,
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
 * Wraps a socket a listener already accepted, which is the server's door.
 *
 * Call it in the listener's connection handler SYNCHRONOUSLY: this end registers its own listeners
 * here, and a frame the socket delivered before that is gone — retention covers a late `onMessage`,
 * not a late transport.
 *
 * Throws `invalid-option` for a socket that is not OPEN, because holding a `Transport` means
 * connected; a socket still connecting belongs to `connectWebSocket`.
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

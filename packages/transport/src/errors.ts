// The code, not the message text, is what a consumer branches on: our bugs should crash, a hostile
// peer's should only close the connection.

/** Every condition the transport and its codecs throw on. */
export type TransportErrorCode =
    /** `encode` was handed a value outside the codec's admissible set, which the wire would drop or transform. */
    | 'encode-rejected'
    /** A frame is not this codec's output at all: wrong type, truncated, unparseable. */
    | 'malformed-frame'
    /** A decoded frame carries `__proto__` / `constructor` / `prototype` — rejected, never stripped. */
    | 'pollution-key'
    /**
     * A frame parsed, but carries a value `encode` would have refused, such as `1e999` decoding to
     * `Infinity` — distinct from `malformed-frame` because the frame is well-formed and only the
     * value is inadmissible, which is the asymmetry a hostile peer probes for.
     */
    | 'unsupported-value'
    /**
     * A frame nests deeper than the decode cap: `JSON.parse` tolerates depth a walk over its result
     * cannot, so a well-formed frame far under any byte cap could otherwise exhaust the stack.
     */
    | 'frame-too-deep'
    /**
     * A frame exceeds the decode byte cap, refused before it is parsed. Depth and byte count bound
     * different things: a shallow frame can still be huge, and parsing is what allocates.
     */
    | 'frame-too-large'
    /** Frames retained for a handler that never registered exceeded the cap. */
    | 'retention-overflow'
    /** A `latency: 0` `deliver()` never ran out of work, because two handlers answer each other. */
    | 'delivery-not-quiescent'
    /** A handler called `deliver()` while a pump was already running, which would re-age both queues. */
    | 'delivery-reentered'
    /** A second `onMessage` / `onClose` on one end, which would split a connection's frames. */
    | 'handler-already-registered'
    /** A factory was handed an option it cannot honour, so nothing was constructed. */
    | 'invalid-option'
    /** A dial never reached OPEN, so no `Transport` was ever handed out and the promise refused. */
    | 'connect-failed'
    /**
     * An established socket ended without either end asking — an `error` event, or a close code
     * neither side wrote. Distinct from a clean close because `onClose` fires for both.
     */
    | 'socket-error'
    /**
     * Consecutive silence windows passed with nothing inbound, so the socket is half-open: the link
     * is gone but TCP has not noticed, which no close event will ever report.
     */
    | 'heartbeat-timeout'
    /** The socket's own send buffer passed its cap, so the peer has stopped draining the connection. */
    | 'send-buffer-overflow';

/** A transport or codec failure with a machine-readable {@link TransportErrorCode}. */
export class TransportError extends Error {
    readonly code: TransportErrorCode;

    constructor(code: TransportErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'TransportError';
        this.code = code;
    }
}

/** Throws a {@link TransportError}. Keeps call sites to one line. */
export function transportError(
    code: TransportErrorCode,
    message: string,
    options?: ErrorOptions,
): never {
    throw new TransportError(code, message, options);
}

// An encoded-frame queue per direction rather than references passed by identity: a trusting
// loopback would be quicker and would reintroduce the silent-divergence class this package kills.

import type { Codec } from './codec.js';
import { jsonCodec } from './codec.js';
import { transportError } from './errors.js';
import { FrameInbox, retentionOverflowMessage, validateRetentionCap } from './inbox.js';
import { DEFAULT_MAX_RETAINED_BYTES } from './transport.js';
import type {
    EncodedFrame,
    Frame,
    LoopbackOptions,
    LoopbackPair,
    Message,
    Transport,
} from './transport.js';

/**
 * How many drain passes a `latency: 0` `deliver()` makes before calling the exchange non-quiescent —
 * well above any real request/response depth, and low enough that a cycle is a prompt error.
 */
const MAX_QUIESCENCE_PASSES = 1000;

/**
 * One end of a loopback pair. Owns its INBOX and writes into the peer's, which is what lets
 * `close()` seal both directions: the flag this end reads on send and the queue it drains are here.
 */
class LoopbackEnd implements Transport {
    readonly #codec: Codec;
    readonly #latency: number;
    readonly #inbox: FrameInbox;

    #peer: LoopbackEnd | undefined;
    #closed = false;
    /**
     * Latched at the overflowing `receive`, thrown from the next `drain`.
     *
     * Deferred because `receive` runs on the SENDER's stack, and a throw there would abort a
     * server's fan-out over its other connections; the next `deliver()` is the host loop that owns
     * the wiring bug.
     */
    #overflow: string | undefined;

    constructor(codec: Codec, latency: number, maxRetainedBytes: number) {
        this.#codec = codec;
        this.#latency = latency;
        this.#inbox = new FrameInbox({
            codec,
            maxRetainedBytes,
            onOverflow: (retained, bytes) => {
                this.#overflow ??= retentionOverflowMessage(
                    retained,
                    bytes,
                    maxRetainedBytes,
                    'life of the process. Register onMessage before the first deliver()',
                );
            },
            onDecodeFailure: (error) => {
                // A hostile frame cannot arrive here — the sender's own encode produced it — so a
                // rejection is the sender's bug and propagates to whoever called deliver().
                throw error;
            },
        });
    }

    /** Called once by `loopbackPair`, before either end is handed out. */
    link(peer: LoopbackEnd): void {
        this.#peer = peer;
    }

    send(message: Message): void {
        // Encoded BEFORE the closed check: a validation failure is the sender's bug either way, and
        // swallowing it on whichever peer happened to drop first would make it timing-dependent.
        this.sendEncoded(this.#codec.encode(message));
    }

    sendEncoded(frame: EncodedFrame): void {
        // A peer that dropped between the tick and the flush must not abort a whole fan-out.
        if (this.#closed) return;
        const peer = this.#peer;
        if (peer !== undefined) peer.#receive(frame);
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
        // Both ends learn on their next drain, never synchronously inside close(), which would
        // re-enter the caller's stack mid-fan-out. The local end queues its own marker so teardown
        // has ONE code path on both ends.
        //
        // `due: 0`, unlike the peer's copy: `latency` models time on the WIRE, and this end learning
        // that it itself closed crosses no wire. It still rides FIFO behind this end's own
        // undelivered frames, so only the delay changes, not the ordering.
        this.#inbox.queueClose(0);
        const peer = this.#peer;
        if (peer !== undefined) peer.#receiveClose();
    }

    /**
     * Peer→this enqueue, sealed after close: the peer does not learn of the close until it drains its
     * marker, and in that window its sends would otherwise land in an inbox nothing will ever drain.
     *
     * A `#` member, not a TypeScript `private`: the latter is erased, leaving a way to enqueue a
     * frame that never passed `encode` onto an object handed out as a `Transport`.
     */
    #receive(frame: Frame): void {
        if (this.#closed) return;
        this.#inbox.enqueue(frame, this.#latency);
    }

    /** Exempt from the seal, unlike a frame: a marker is how the peer learns the connection ended. */
    #receiveClose(): void {
        this.#inbox.queueClose(this.#latency);
    }

    /**
     * Ages this end's queue by one `deliver()` pass.
     *
     * Separate from `drain` because BOTH ends must age before EITHER delivers: ageing inside `drain`
     * would let a frame the client's handler sends be aged by the server's own `drain` later in the
     * same `deliver()`, making the delay direction-dependent.
     */
    age(): void {
        this.#inbox.age();
    }

    /**
     * Drains this end's inbox into its handlers, and reports a retention overflow.
     *
     * The overflow surfaces HERE and not in the drain a registration runs, so the throw lands on the
     * host loop that owns the wiring bug rather than inside a handler call — registering a handler
     * must not fail because of a frame that predates it.
     */
    drain(): void {
        const overflow = this.#overflow;
        if (overflow !== undefined) {
            // Cleared as it is reported: the frames were already dropped, so re-throwing every
            // deliver() would be a stuck pump rather than new information.
            this.#overflow = undefined;
            transportError('retention-overflow', overflow);
        }
        this.#inbox.drain();
    }

    /** True while anything is eligible and a handler exists to take it — the `latency: 0` loop's test. */
    get deliverable(): boolean {
        return this.#inbox.deliverable;
    }
}

/**
 * Hands out only the `Transport` surface, so `link` / `age` / `drain` cannot be reached from a
 * consumer holding one end — a TypeScript `private` would not have stopped that, and `link` in
 * particular can re-point a live pair at a third end.
 */
function transportFacade(end: LoopbackEnd): Transport {
    return {
        send: (message) => end.send(message),
        sendEncoded: (frame) => end.sendEncoded(frame),
        onMessage: (handler) => end.onMessage(handler),
        onClose: (handler) => end.onClose(handler),
        close: () => end.close(),
    };
}

/**
 * Loopback: a pair, connected at construction, because a socket has a connecting phase and loopback
 * does not — so a `Transport` is only ever handed out once connected. The host app owns `deliver()`.
 */
export function loopbackPair(opts?: LoopbackOptions): LoopbackPair {
    const codec = opts?.codec ?? jsonCodec;
    const latency = opts?.latency ?? 1;
    const maxRetainedBytes = opts?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;

    if (!Number.isInteger(latency) || latency < 0) {
        transportError(
            'invalid-option',
            `latency counts deliver() calls, so it must be a non-negative integer; received ${String(latency)}.`,
        );
    }
    validateRetentionCap(maxRetainedBytes);

    const client = new LoopbackEnd(codec, latency, maxRetainedBytes);
    const server = new LoopbackEnd(codec, latency, maxRetainedBytes);
    client.link(server);
    server.link(client);

    let pumping = false;

    return {
        client: transportFacade(client),
        server: transportFacade(server),
        deliver(): void {
            // A handler that reaches the pump would age both queues a second time inside one tick,
            // so a frame would arrive a tick early and `latency` would stop counting deliver() calls.
            // Named rather than ignored: the host loop owns the tick, and a handler calling it is a
            // wiring bug, not a flush.
            if (pumping) {
                transportError(
                    'delivery-reentered',
                    'deliver() was called from inside a handler, while a pump was already running. That would age both queues twice in one tick, delivering a frame earlier than latency promises. Send instead, and let the next tick deliver it.',
                );
            }
            pumping = true;
            try {
                pump();
            } finally {
                // Restored even when a handler throws, which is ordinary: otherwise one bad handler
                // would latch the pump and silently stop the connection for good.
                pumping = false;
            }
        },
    };

    function pump(): void {
        // Both ends age before either delivers, so the delay does not depend on which direction is
        // walked first.
        client.age();
        server.age();

        // Client first is deliberate but not load-bearing at the default latency: the one-tick
        // outbound delay comes from draining at the TOP of the tick, not from walk order.
        client.drain();
        server.drain();

        if (latency > 0) return;

        // At latency 0 a frame a handler just sent is ALREADY eligible, so one pass per end would
        // leave it for the next deliver() and `latency: 0` would still cost a tick. Loop to
        // quiescence instead, bounded because two handlers answering each other never settle.
        for (let pass = 0; client.deliverable || server.deliverable; pass++) {
            if (pass >= MAX_QUIESCENCE_PASSES) {
                transportError(
                    'delivery-not-quiescent',
                    `deliver() ran ${MAX_QUIESCENCE_PASSES} passes at latency 0 and the queues are still not empty, which means two handlers are answering each other: at zero latency each reply is eligible within the same deliver(), so the exchange never settles. Break the cycle, or use the default latency of 1, where each leg costs a tick.`,
                );
            }
            client.drain();
            server.drain();
        }
    }
}

// The smallest loopback that is FAITHFUL: an encoded-frame queue per direction, an encode on the way
// in, a decode on the way out. A trusting loopback passing references by identity would be quicker
// and would reintroduce the silent-divergence class this package exists to kill.
//
// Two properties are load-bearing. The queue holds frames rather than live objects, so a peer cannot
// receive a reference into the sender's own state. And `deliver()` runs at the TOP of the tick, so
// frames the server produces DURING a step land at the next tick's top — server→client is one tick
// behind, 50 ms at 20 Hz, which keeps the client's prediction path exercised in every local playtest
// instead of executing for the first time in production.
//
// Ordering is strict FIFO per direction because order IS meaning for the structural channel:
// destroy-then-spawn and spawn-then-destroy leave different worlds.

import type { Codec } from './codec.js';
import { jsonCodec } from './codec.js';
import { transportError } from './errors.js';
import type {
    EncodedFrame,
    Frame,
    LoopbackOptions,
    LoopbackPair,
    Message,
    Transport,
} from './transport.js';

/** A symbol rather than a sentinel frame value, so no encodable message can be mistaken for one. */
const CLOSE_MARKER = Symbol('transport.close');

/**
 * An inbox entry. `due` counts DOWN, so ageing is one decrement per pass rather than a comparison
 * against a tick counter this package has no business keeping.
 */
interface Queued {
    readonly item: Frame | typeof CLOSE_MARKER;
    /** Bytes, via `codec.byteLength`. Zero for the close marker, which is not a frame. */
    readonly bytes: number;
    due: number;
}

/** 1 MiB. Large enough that no legitimate join sequence reaches it, small enough to bound a leak. */
const DEFAULT_MAX_RETAINED_BYTES = 1024 * 1024;

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
    readonly #maxRetainedBytes: number;
    readonly #inbox: Queued[] = [];
    /**
     * Where the undelivered frames start. A head index rather than `shift()` per frame, because
     * `shift()` stops being cheap once the backing store leaves V8's trimmable regime: draining a
     * 100k-frame backlog cost 4.4 s that way and 46 ms this way. A burst that big is reachable at the
     * default cap, since the cap bounds BYTES and a one-byte frame is legal.
     */
    #head = 0;

    #peer: LoopbackEnd | undefined;
    #onMessage: ((message: Message) => void) | undefined;
    #onClose: (() => void) | undefined;
    #closed = false;
    /** Latched so `onClose` fires exactly once even if a marker is somehow queued twice. */
    #closeFired = false;
    /** Bytes of undelivered frames in the inbox — the quantity the cap bounds while unhandled. */
    #queuedBytes = 0;
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
        this.#maxRetainedBytes = maxRetainedBytes;
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
        if (this.#onMessage !== undefined) {
            transportError(
                'handler-already-registered',
                "onMessage is already registered on this end; a second handler would split this connection's frames between two consumers. Dispose the first, or fan out above the transport.",
            );
        }
        this.#onMessage = handler;
        // The join sequence races wiring order, so frames that arrived with no handler were retained
        // rather than dropped — flush them now, in order.
        this.#drain();
        return () => {
            if (this.#onMessage === handler) this.#onMessage = undefined;
        };
    }

    onClose(handler: () => void): () => void {
        if (this.#onClose !== undefined) {
            transportError(
                'handler-already-registered',
                'onClose is already registered on this end. Dispose the first, or fan out above the transport.',
            );
        }
        this.#onClose = handler;
        this.#drain();
        return () => {
            if (this.#onClose === handler) this.#onClose = undefined;
        };
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
        this.#inbox.push({ item: CLOSE_MARKER, bytes: 0, due: 0 });
        const peer = this.#peer;
        if (peer !== undefined) peer.#receive(CLOSE_MARKER);
    }

    /**
     * Peer→this enqueue, sealed after close: the peer does not learn of the close until it drains its
     * marker, and in that window its sends would otherwise land in an inbox nothing will ever drain.
     *
     * A `#` member, not a TypeScript `private`: the latter is erased, leaving a way to enqueue a
     * frame that never passed `encode` onto an object handed out as a `Transport`.
     */
    #receive(item: Frame | typeof CLOSE_MARKER): void {
        if (this.#closed && item !== CLOSE_MARKER) return;

        // The marker is exempt from the cap: it carries no payload and is how the peer learns the
        // connection ended, so dropping it for a byte limit would strand teardown.
        if (item === CLOSE_MARKER) {
            this.#inbox.push({ item, bytes: 0, due: this.#latency });
            return;
        }

        const bytes = this.#codec.byteLength(item);
        // Enforced only while no handler is registered, though the byte count is maintained always:
        // a backlog behind a live handler is the pump running late, which backpressure above the
        // transport answers; a backlog behind no handler at all can never drain on its own.
        if (this.#onMessage === undefined && this.#queuedBytes + bytes > this.#maxRetainedBytes) {
            // Dropped rather than queued — the whole point of a cap is that memory stops growing.
            this.#overflow ??= `Retained ${this.#queuedBytes} bytes for a handler that never registered, and this frame's ${bytes} would pass the ${this.#maxRetainedBytes}-byte cap. Frames are retained until onMessage registers, so a join sequence that throws before wiring it grows this inbox for the life of the process. Register onMessage before the first deliver(), or raise maxRetainedBytes.`;
            return;
        }

        this.#queuedBytes += bytes;
        this.#inbox.push({ item, bytes, due: this.#latency });
    }

    /**
     * Ages this end's queue by one `deliver()` pass.
     *
     * Separate from `drain` because BOTH ends must age before EITHER delivers: ageing inside `drain`
     * would let a frame the client's handler sends be aged by the server's own `drain` later in the
     * same `deliver()`, making the delay direction-dependent.
     */
    age(): void {
        for (let i = this.#head; i < this.#inbox.length; i++) {
            const entry = this.#inbox[i] as Queued;
            if (entry.due > 0) entry.due--;
        }
    }

    /**
     * Drains this end's inbox into its handlers, and reports a retention overflow.
     *
     * The overflow surfaces HERE and not in the private `#drain` a registration runs, so the throw
     * lands on the host loop that owns the wiring bug rather than inside a handler call —
     * registering a handler must not fail because of a frame that predates it.
     */
    drain(): void {
        const overflow = this.#overflow;
        if (overflow !== undefined) {
            // Cleared as it is reported: the frames were already dropped, so re-throwing every
            // deliver() would be a stuck pump rather than new information.
            this.#overflow = undefined;
            transportError('retention-overflow', overflow);
        }
        this.#drain();
    }

    /** True while anything is eligible and a handler exists to take it — the `latency: 0` loop's test. */
    get deliverable(): boolean {
        const next = this.#inbox[this.#head];
        if (next === undefined || next.due > 0) return false;
        return next.item === CLOSE_MARKER
            ? this.#onClose !== undefined
            : this.#onMessage !== undefined;
    }

    /** Reclaims the consumed prefix, so a long-lived connection's array does not grow without bound. */
    #compact(): void {
        if (this.#head === 0) return;
        if (this.#head >= this.#inbox.length) {
            this.#inbox.length = 0;
            this.#head = 0;
            return;
        }
        // Only once the consumed prefix outweighs what is left, so the copy is amortised O(1)/frame.
        if (this.#head >= 1024 && this.#head * 2 >= this.#inbox.length) {
            this.#inbox.splice(0, this.#head);
            this.#head = 0;
        }
    }

    #drain(): void {
        // Consumed one at a time rather than from a snapshot, which buys three properties a snapshot
        // loses: a handler that closes mid-drain leaves anything behind the marker unconsumed; one
        // that disposes itself leaves the rest RETAINED for the next registration rather than
        // delivered into a disposed closure; and one that throws leaves the frames behind it queued
        // rather than dropped. A `send` from inside a handler lands in the PEER's inbox, so it cannot
        // extend this loop.
        while (this.#head < this.#inbox.length) {
            const next = this.#inbox[this.#head] as Queued;

            // Strict FIFO outranks the delay: a frame still waiting holds everything behind it, so
            // when jitter arrives this is the line that keeps reordering an explicit choice rather
            // than a side effect of per-frame delays.
            if (next.due > 0) break;

            if (next.item === CLOSE_MARKER) {
                if (this.#onClose === undefined) break; // retain; fires on register
                this.#head++;
                if (this.#closeFired) continue;
                this.#closeFired = true;
                this.#onClose();
                continue;
            }

            if (this.#onMessage === undefined) break; // retain; flushed on register
            this.#head++;
            this.#queuedBytes -= next.bytes;
            // Decode is paid on delivery, not on enqueue, so a frame dropped under pressure costs
            // nothing more to discard. A hostile frame cannot arrive here in loopback — the sender's
            // own encode produced it — so a throw is the sender's bug and propagates.
            this.#onMessage(this.#codec.decode(next.item));
        }
        this.#compact();
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
    if (!(maxRetainedBytes > 0)) {
        transportError(
            'invalid-option',
            `maxRetainedBytes must be a positive byte count; received ${String(maxRetainedBytes)}.`,
        );
    }

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

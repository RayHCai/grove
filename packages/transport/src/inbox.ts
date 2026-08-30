// One FIFO carrying frames and the terminal marker together is what puts `onClose` behind every
// frame ahead of it however the two handlers were registered.

import type { Codec } from './codec.js';
import { transportError } from './errors.js';
import type { Frame, Message } from './transport.js';

/** A symbol rather than a sentinel frame value, so no encodable message can be mistaken for one. */
const CLOSE_MARKER = Symbol('transport.close');

/**
 * An inbox entry. `due` counts DOWN, so ageing is one decrement per pass rather than a comparison
 * against a tick counter this package has no business keeping; an end with no pump leaves it at 0.
 */
interface Queued {
    readonly item: Frame | typeof CLOSE_MARKER;
    /** Bytes, via `codec.byteLength`. Zero for the close marker, which is not a frame. */
    readonly bytes: number;
    due: number;
}

/**
 * The registration refusals, held here so the two backends cannot drift a word apart: a consumer
 * reads the message, and one wire failing differently from the other is the drift this package
 * exists to kill.
 */
const MESSAGE_HANDLER_TAKEN =
    "onMessage is already registered on this end; a second handler would split this connection's frames between two consumers. Dispose the first, or fan out above the transport.";
const CLOSE_HANDLER_TAKEN =
    'onClose is already registered on this end. Dispose the first, or fan out above the transport.';

/**
 * The overflow message both backends report, for the same reason.
 *
 * `advice` carries the only genuine difference: the lifetime that leaks and the wiring point to
 * move, which are not the same sentence on a pumped wire and on a socket.
 */
export function retentionOverflowMessage(
    retained: number,
    bytes: number,
    cap: number,
    advice: string,
): string {
    return `Retained ${retained} bytes for a handler that never registered, and this frame's ${bytes} would pass the ${cap}-byte cap. Frames are retained until onMessage registers, so a join sequence that throws before wiring it grows this inbox for the ${advice}, or raise maxRetainedBytes.`;
}

/** Where the two backends answer differently; everything else about an inbox is shared. */
export interface InboxPolicy {
    readonly codec: Codec;
    /** Bounds bytes retained while no handler is registered, summed via `codec.byteLength`. */
    readonly maxRetainedBytes: number;
    /**
     * A frame the cap refused, already dropped: `retained` is what was held before it, `bytes` its
     * own. Loopback latches the condition and throws from its next pump; a socket reports it once and
     * stays up.
     */
    onOverflow(retained: number, bytes: number): void;
    /**
     * A `decode` rejection on the frame just consumed. Throwing propagates out of the drain; returning
     * abandons the drain, leaving everything behind that frame queued.
     */
    onDecodeFailure(error: unknown): void;
}

/**
 * One end's inbox: the queue, its handlers, the retention accounting, and the drain.
 *
 * Held as a `#` member by both ends, so a consumer holding a `Transport` cannot reach it — a
 * TypeScript `private` is erased and would not have stopped that.
 */
export class FrameInbox {
    readonly #policy: InboxPolicy;
    readonly #entries: Queued[] = [];
    /**
     * Where the undelivered entries start. A head index rather than `shift()` per frame, because
     * `shift()` stops being cheap once the backing store leaves V8's trimmable regime, and a
     * 100k-frame backlog is reachable at the default cap: the cap bounds BYTES, and a one-byte
     * frame is legal.
     */
    #head = 0;

    #onMessage: ((message: Message) => void) | undefined;
    #onClose: (() => void) | undefined;
    /** Latched so `onClose` fires exactly once even if a marker is somehow queued twice. */
    #closeFired = false;
    /** Bytes of undelivered frames — the quantity the cap bounds while unhandled. */
    #queuedBytes = 0;

    constructor(policy: InboxPolicy) {
        this.#policy = policy;
    }

    registerMessage(handler: (message: Message) => void): () => void {
        if (this.#onMessage !== undefined) {
            transportError('handler-already-registered', MESSAGE_HANDLER_TAKEN);
        }
        this.#onMessage = handler;
        // The join sequence races wiring order, so frames that arrived with no handler were retained
        // rather than dropped — flush them now, in order.
        this.drain();
        return () => {
            if (this.#onMessage === handler) this.#onMessage = undefined;
        };
    }

    registerClose(handler: () => void): () => void {
        if (this.#onClose !== undefined) {
            transportError('handler-already-registered', CLOSE_HANDLER_TAKEN);
        }
        this.#onClose = handler;
        this.drain();
        return () => {
            if (this.#onClose === handler) this.#onClose = undefined;
        };
    }

    /** Queues an arrived frame, or drops it and reports when the retention cap refuses it. */
    enqueue(frame: Frame, due = 0): void {
        const bytes = this.#policy.codec.byteLength(frame);
        // Enforced only while no handler is registered, though the byte count is maintained always:
        // a backlog behind a live handler is the pump running late, which backpressure above the
        // transport answers; a backlog behind no handler at all can never drain on its own.
        if (
            this.#onMessage === undefined &&
            this.#queuedBytes + bytes > this.#policy.maxRetainedBytes
        ) {
            // Dropped rather than queued — the whole point of a cap is that memory stops growing.
            this.#policy.onOverflow(this.#queuedBytes, bytes);
            return;
        }

        this.#queuedBytes += bytes;
        this.#entries.push({ item: frame, bytes, due });
    }

    /**
     * Queues the terminal marker, exempt from the cap: it carries no payload and is how this end
     * learns the connection ended, so dropping it for a byte limit would strand teardown.
     */
    queueClose(due = 0): void {
        this.#entries.push({ item: CLOSE_MARKER, bytes: 0, due });
    }

    /** Ages the queue by one pump pass; a no-op for an end that queues everything already due. */
    age(): void {
        for (let i = this.#head; i < this.#entries.length; i++) {
            const entry = this.#entries[i] as Queued;
            if (entry.due > 0) entry.due--;
        }
    }

    /** True while anything is eligible and a handler exists to take it — the `latency: 0` loop's test. */
    get deliverable(): boolean {
        const next = this.#entries[this.#head];
        if (next === undefined || next.due > 0) return false;
        return next.item === CLOSE_MARKER
            ? this.#onClose !== undefined
            : this.#onMessage !== undefined;
    }

    drain(): void {
        // Consumed one at a time rather than from a snapshot, which buys three properties a snapshot
        // loses: a handler that closes mid-drain leaves anything behind the marker unconsumed; one
        // that disposes itself leaves the rest RETAINED for the next registration rather than
        // delivered into a disposed closure; and one that throws leaves the frames behind it queued
        // rather than dropped. A `send` from inside a handler never reaches the inbox it is draining —
        // loopback lands it in the PEER's, a socket writes it to the wire — so it cannot extend this loop.
        while (this.#head < this.#entries.length) {
            const next = this.#entries[this.#head] as Queued;

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

            let message: Message;
            try {
                // Decode is paid on delivery, not on enqueue, so a frame dropped under pressure costs
                // nothing more to discard.
                message = this.#policy.codec.decode(next.item);
            } catch (error) {
                this.#policy.onDecodeFailure(error);
                // Left uncompacted deliberately: a policy that returns has abandoned this drain, and
                // the entries behind the failed frame are still the next drain's to deliver.
                return;
            }

            this.#onMessage(message);
        }
        this.#compact();
    }

    /** Reclaims the consumed prefix, so a long-lived connection's array does not grow without bound. */
    #compact(): void {
        if (this.#head === 0) return;
        if (this.#head >= this.#entries.length) {
            this.#entries.length = 0;
            this.#head = 0;
            return;
        }
        // Only once the consumed prefix outweighs what is left, so the copy is amortised O(1)/frame.
        if (this.#head >= 1024 && this.#head * 2 >= this.#entries.length) {
            this.#entries.splice(0, this.#head);
            this.#head = 0;
        }
    }
}

/** Both factories take the retention cap, so both refuse a bad one with one message. */
export function validateRetentionCap(maxRetainedBytes: number): void {
    if (!(maxRetainedBytes > 0)) {
        transportError(
            'invalid-option',
            `maxRetainedBytes must be a positive byte count; received ${String(maxRetainedBytes)}.`,
        );
    }
}

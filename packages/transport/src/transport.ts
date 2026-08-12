// Imports nothing from an implementation, so a backend can implement these types without pulling
// another implementation's pump into its module graph.

import type { Codec } from './codec.js';

/** The JSON value space — what `jsonCodec` carries, and the floor every codec must accept. */
export type JsonValue =
    null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * What the endpoints send and receive, untrusted on receive — the transport narrows nothing.
 *
 * Declare envelopes as `type` aliases: an `interface` has no index signature and is not assignable.
 */
export type Message = JsonValue;

/** What crosses the wire — a string under `jsonCodec`, `Uint8Array` under a binary codec. */
export type Frame = string | Uint8Array;

declare const ENCODED_BY_CODEC: unique symbol;

/**
 * A frame minted by `Codec.encode` — the only authority that can assert the brand.
 *
 * `sendEncoded` skips the receiving end's own `encode`, so a hand-built or foreign-codec frame has
 * to fail at the call site rather than at the peer's `decode`.
 */
export type EncodedFrame = Frame & { readonly [ENCODED_BY_CODEC]: true };

/** Scheduling seam for the websocket heartbeat, injected so a silence cutoff needs no wall clock. */
export interface TimerSource {
    /** Returns an opaque handle `clearInterval` accepts. */
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

/** One end of one ESTABLISHED connection — holding a `Transport` means connected. */
export interface Transport {
    /** Encode via the injected codec and hand the frame to the peer; a silent no-op after close. */
    send(message: Message): void;

    /**
     * Enqueue an already-encoded frame, skipping this end's encode.
     *
     * Sound only because the codec is process-uniform: the server encodes a broadcast once and calls
     * this per connection.
     */
    sendEncoded(frame: EncodedFrame): void;

    /**
     * Register the peer-message handler; returns a disposer.
     *
     * Frames that arrived before registration are retained and flushed here, because the join
     * sequence races wiring order. One handler per end — a second live registration throws, since
     * two consumers would split this connection's frames.
     */
    onMessage(handler: (message: Message) => void): () => void;

    /** Register the close handler; fires once, after every frame ahead of it, never inside `close()`. */
    onClose(handler: () => void): () => void;

    /** Close this end; idempotent, and the peer's `onClose` fires behind its queued frames. */
    close(): void;
}

/** Options every factory accepts. */
export interface TransportOptions {
    /** Defaults to `jsonCodec`; one codec per process, which is what makes `sendEncoded` sound. */
    codec?: Codec;
    /**
     * Cap on bytes retained for a handler that has not registered yet, summed via
     * `codec.byteLength`; defaults to 1 MiB.
     *
     * Uncapped retention leaks: a connection whose join sequence throws before reaching `onMessage`
     * never registers one, so its inbox grows for the life of the process.
     */
    maxRetainedBytes?: number;
}

/** Options for the loopback factory; its own type because a socket has no `deliver()` to count. */
export interface LoopbackOptions extends TransportOptions {
    /**
     * How many `deliver()` calls a frame waits before its handler can see it; defaults to 1.
     *
     * `latency: 0` delivers inside one pump, which separates a prediction bug from a simulation bug
     * in a single run. It does not make a local round trip free: the server enqueues during
     * `step()`, after that tick's `deliver()` returned, so server→client stays a tick behind
     * whatever this is set to.
     */
    latency?: number;
}

/** Options for the networked factory, taken now so a websocket backend needs no signature change. */
export interface ConnectOptions extends TransportOptions {
    /** Rebinds a reconnecting client to its existing `Player`; server-minted and opaque. */
    token?: string;
    /** The heartbeat's scheduling seam; defaults to a real-time source. */
    timer?: TimerSource;
}

/** Resolves once the socket is OPEN, so a caller never holds an unconnected `Transport`. */
export type Connect = (url: string, opts?: ConnectOptions) => Promise<Transport>;

/** A connected pair of ends plus the pump the host application owns. */
export interface LoopbackPair {
    readonly client: Transport;
    readonly server: Transport;
    /** Drain both inboxes into their handlers; called at the TOP of each server tick. */
    deliver(): void;
}

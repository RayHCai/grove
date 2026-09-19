// Imports nothing from an implementation, so a backend can implement these types without pulling
// another implementation's pump into its module graph.

import type { Codec } from './codec.js';

/**
 * 1 MiB. Large enough that no legitimate join reaches it, small enough to bound a leak.
 * Here rather than in one implementation, since every factory defaults to it.
 */
export const DEFAULT_MAX_RETAINED_BYTES = 1024 * 1024;

/** The JSON value space — what `jsonCodec` carries, and the floor every codec must accept. */
export type JsonValue =
    null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * What the endpoints send and receive, untrusted on receive — the transport narrows nothing.
 * Declare envelopes as `type`: an `interface` has no index signature and is not assignable.
 */
export type Message = JsonValue;

/** What crosses the wire — a string under `jsonCodec`, `Uint8Array` under a binary codec. */
export type Frame = string | Uint8Array;

declare const ENCODED_BY_CODEC: unique symbol;

/**
 * A frame minted by `Codec.encode` — the only authority that can assert the brand.
 * `sendEncoded` skips the far end's `encode`, so a foreign frame fails at the call site.
 */
export type EncodedFrame = Frame & { readonly [ENCODED_BY_CODEC]: true };

/** Scheduling seam for the websocket heartbeat, so a silence cutoff needs no wall clock. */
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
     * Enqueue an already-encoded frame, skipping this end's encode. Sound only because the codec
     * is process-uniform: the server encodes a broadcast once and calls this per connection.
     */
    sendEncoded(frame: EncodedFrame): void;

    /**
     * Register the peer-message handler; returns a disposer. Frames that arrived before it
     * are retained and flushed here. One handler per end — a second live registration throws.
     */
    onMessage(handler: (message: Message) => void): () => void;

    /** Register the close handler; fires once, after every frame ahead of it. */
    onClose(handler: () => void): () => void;

    /** Close this end; idempotent, and the peer's `onClose` fires behind its queued frames. */
    close(): void;
}

/** Options every factory accepts. */
export interface TransportOptions {
    /** Defaults to `jsonCodec`; one codec per process, which is what makes `sendEncoded` sound. */
    codec?: Codec;
    /**
     * Cap on bytes retained for a handler that has not registered yet; defaults to 1 MiB.
     * Uncapped it leaks: a join that throws before `onMessage` grows its inbox forever.
     */
    maxRetainedBytes?: number;
}

/** Options for the loopback factory; its own type because a socket has no `deliver()` to count. */
export interface LoopbackOptions extends TransportOptions {
    /**
     * How many `deliver()` calls a frame waits before its handler sees it; defaults to 1.
     * `latency: 0` delivers inside one pump, but a local round trip still costs a tick.
     */
    latency?: number;
}

/** Options for the networked factory, which `connectWebSocket` widens with its own. */
export interface ConnectOptions extends TransportOptions {
    /**
     * Rebinds a reconnecting client to its existing `Player`; server-minted and opaque.
     * Its wire slot is `JoinRequest.token`, which protocol owns, so no backend here sends it.
     */
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

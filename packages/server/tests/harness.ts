// The test harness: a GameServer over one or more loopbackPairs, driven by a scripted clock.
//
// Pure, no wall-clock and no socket, the way core, the renderer and transport are validated. The
// composition root's shape is reproduced faithfully in one respect that matters: `deliver` is handed
// to the DRIVER and drains every pair, so no test ever sequences delivery against a step itself —
// a test that had to order the two would be reproducing the bug that owning the sequence removes.

import type {
    GameRequest,
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    JoinRequest,
    Reject,
    RequestFrame,
    ServerToClient,
    StateEnvelope,
    TimeSyncReply,
    TransformEnvelope,
    Welcome,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type {
    Codec,
    EncodedFrame,
    Frame,
    LoopbackPair,
    Message,
    Transport,
} from '@platform/transport';
import { defined } from '@platform/math';
import { jsonCodec, loopbackPair } from '@platform/transport';
import type { BreakerTrip, LogSink } from '@platform/core';
import { GameServer } from '../src/server.js';
import type { ServerConfig } from '../src/server.js';
import type { PumpResult } from '../src/driver.js';

/** One client end. It speaks the wire and records everything it is told, and nothing else. */
export class Peer {
    readonly received: ServerToClient[] = [];
    readonly #transport: Transport;
    #seq = 0;

    constructor(transport: Transport) {
        this.#transport = transport;
        this.#transport.onMessage((message) => {
            this.received.push(message as unknown as ServerToClient);
        });
    }

    /**
     * The first frame on a connection — the client speaks first.
     *
     * Declares no project by default, which is what an unconfigured server declares too: the
     * identity check passes on agreement, not on absence, so a test that wants a mismatch says so.
     */
    join(name = 'peer', over: Partial<JoinRequest> = {}): void {
        const request: JoinRequest = {
            kind: 'join-request',
            protocolVersion: PROTOCOL_VERSION,
            name,
            clientSentMs: 1000,
            projectId: '',
            projectHash: '',
            bundleHash: '',
            ...over,
        };
        this.#send(request);
    }

    /** One tick's batch, `seq` advancing with it. Returns the seq it used. */
    input(tick: number, actions: InputAction[], over: Partial<InputFrame> = {}): number {
        const frame: InputFrame = {
            kind: 'input',
            tick,
            seq: this.#seq++,
            actions,
            ...over,
        };
        this.#send(frame);
        return frame.seq;
    }

    /** Sends a frame with a chosen seq without disturbing the counter — for the gap tests. */
    inputAt(seq: number, tick: number, actions: InputAction[]): void {
        this.#send({ kind: 'input', tick, seq, actions } satisfies InputFrame);
    }

    /** Burns `n` seq values without sending them, so the next `input` leaves a gap. */
    skipSeq(n = 1): void {
        this.#seq += n;
    }

    /** One tick's HUD presses and pointer hits. It carries no seq, so it disturbs no ack. */
    interaction(tick: number, events: Interaction[]): void {
        this.#send({ kind: 'interaction', tick, events } satisfies InteractionFrame);
    }

    /** One tick's `request()` calls. It carries no seq either, so it disturbs no ack. */
    request(tick: number, requests: GameRequest[]): void {
        this.#send({ kind: 'request', tick, requests } satisfies RequestFrame);
    }

    timeSync(clientSentMs: number): void {
        this.#send({ kind: 'time-sync', clientSentMs });
    }

    /** Sends whatever it is handed, so a malformed-frame test can reach the narrowing. */
    raw(message: unknown): void {
        this.#transport.send(message as Message);
    }

    close(): void {
        this.#transport.close();
    }

    get welcome(): Welcome | undefined {
        return this.received.find((e): e is Welcome => e.kind === 'welcome');
    }

    get reject(): Reject | undefined {
        return this.received.find((e): e is Reject => e.kind === 'reject');
    }

    get timeSyncReplies(): TimeSyncReply[] {
        return this.received.filter((e): e is TimeSyncReply => e.kind === 'time-sync-reply');
    }

    get states(): StateEnvelope[] {
        return this.received.filter((e): e is StateEnvelope => e.kind === 'state');
    }

    get transforms(): TransformEnvelope[] {
        return this.received.filter((e): e is TransformEnvelope => e.kind === 'transform');
    }

    /** The newest state envelope, which is what a test usually means by "the ack". */
    get lastState(): StateEnvelope | undefined {
        return this.states.at(-1);
    }

    clear(): void {
        this.received.length = 0;
    }

    #send(envelope: unknown): void {
        this.#transport.send(envelope as Message);
    }
}

/** Counts `encode` calls, so the encode-once claim is measured rather than assumed. */
export class CountingCodec implements Codec {
    encodes = 0;
    decodes = 0;

    encode(message: Message): EncodedFrame {
        this.encodes += 1;
        return jsonCodec.encode(message);
    }

    decode(frame: Frame): Message {
        this.decodes += 1;
        return jsonCodec.decode(frame);
    }

    byteLength(frame: Frame): number {
        return jsonCodec.byteLength(frame);
    }
}

export interface HarnessOptions {
    config?: ServerConfig;
    codec?: Codec;
    /** `deliver()` passes a frame waits. 1 is transport's faithful default; 0 removes the delay. */
    latency?: number;
    /** The dev channel, so a test can watch what the host would be told. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
    /** Where the server's decisions go, so a test reads exactly what an operator would grep. */
    log?: LogSink;
}

export class Harness {
    readonly server: GameServer;
    readonly #pairs: LoopbackPair[] = [];
    readonly #latency: number;
    #now = 0;
    #base = 0;
    #wakes = 0;
    #lastAcceptId: string | null = null;

    constructor(opts: HarnessOptions = {}) {
        this.#latency = opts.latency ?? 1;
        this.server = new GameServer({
            ...defined({
                config: opts.config,
                codec: opts.codec,
                onBreakerTrip: opts.onBreakerTrip,
                log: opts.log,
            }),
            // Handed to the driver, never called by a test around `pump`.
            deliver: () => {
                for (const pair of this.#pairs) pair.deliver();
            },
        });
    }

    /** A new connection: the harness plays the composition root wiring a factory into `accept`. */
    connect(playerId?: string): Peer {
        const pair = loopbackPair({ latency: this.#latency, codec: jsonCodec });
        this.#pairs.push(pair);
        this.#lastAcceptId =
            playerId === undefined
                ? this.server.accept(pair.server)
                : this.server.accept(pair.server, playerId);
        return new Peer(pair.client);
    }

    /** What `accept` returned for the most recent `connect()` — null when it was refused. */
    get lastAcceptId(): string | null {
        return this.#lastAcceptId;
    }

    get now(): number {
        return this.#now;
    }

    get tick(): number {
        return this.server.runtime.tick;
    }

    /**
     * Advances the scripted clock by `seconds` and wakes the server once — a JUMP, for the gap and
     * backwards-clock cases.
     *
     * It re-bases the tick counter, so a later `pumpTicks` advances from HERE. Without that the two
     * would keep separate clocks and a `pumpTicks` after a multi-second `pump` would hand the driver
     * a backwards reading, which runs zero steps — so a test would pass or fail for reasons that have
     * nothing to do with what it asserts.
     */
    pump(seconds: number): PumpResult {
        this.#base = this.#now + seconds;
        this.#wakes = 0;
        this.#now = this.#base;
        return this.server.pump(this.#now);
    }

    /**
     * `n` wakes of exactly one tick each — the ordinary case. Returns the sends they produced.
     *
     * The clock is `base + k / simRate` off an INTEGER counter rather than a running sum, so the wake
     * boundaries do not drift: repeated addition of `1 / 60` accumulates error, and the driver's own
     * `>= dt` test then owes a tick it cannot measure.
     */
    pumpTicks(n = 1): number {
        const dt = 1 / this.server.config.simRate;
        let sends = 0;
        for (let i = 0; i < n; i++) {
            this.#wakes += 1;
            this.#now = this.#base + this.#wakes * dt;
            sends += this.server.pump(this.#now).sends;
        }
        return sends;
    }

    /**
     * Pumps single ticks until a send-tick has just fired, so a test that cares about one send
     * interval starts at a known boundary rather than wherever the joins left the cadence.
     */
    alignToSend(limit = 64): void {
        for (let i = 0; i < limit; i++) {
            if (this.pumpTicks(1) > 0) return;
        }
        throw new Error('no send-tick within the limit — the cadence is wrong');
    }

    /**
     * A join that has completed and whose Welcome has been delivered.
     *
     * Pumps until the Welcome arrives rather than a fixed count: the server answers a join at the
     * next SEND-tick, so the snapshot and the journal are cut at the same instant, which puts
     * the reply up to one send interval plus one delivery after the request.
     */
    joined(name = 'peer', limit = 32): Peer {
        const peer = this.connect();
        peer.join(name);
        for (let i = 0; i < limit; i++) {
            this.pumpTicks(1);
            if (peer.welcome !== undefined || peer.reject !== undefined) return peer;
        }
        throw new Error(`no Welcome or Reject within ${limit} ticks`);
    }

    /**
     * `joined`, for a host-named peer — whose admission waits on a persisted read.
     *
     * Flushes a macrotask per tick rather than only a microtask, so it settles against a `KVStore`
     * that answers on a timer as well as one that resolves immediately.
     */
    async joinedAs(playerId: string, name = playerId, limit = 32): Promise<Peer> {
        const peer = this.connect(playerId);
        peer.join(name);
        for (let i = 0; i < limit; i++) {
            this.pumpTicks(1);
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (peer.welcome !== undefined || peer.reject !== undefined) return peer;
        }
        throw new Error(`no Welcome or Reject within ${limit} ticks`);
    }

    /** Drives past a send-tick and empties every peer, so a test starts from a settled world. */
    settle(peers: Peer[], ticks = 6): void {
        this.pumpTicks(ticks);
        this.alignToSend();
        this.pumpTicks(2);
        for (const peer of peers) peer.clear();
    }
}

export function harness(opts: HarnessOptions = {}): Harness {
    return new Harness(opts);
}

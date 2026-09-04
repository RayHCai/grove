// The test harness: a Sim driven one batch at a time, with this file playing the host.
//
// Pure, no wall-clock and no socket, the way core, the renderer and transport are validated. What a
// real host does around the sim is reproduced here in miniature — a send cadence counted on its own
// clock, a store the loads and saves go through, and a peer per connection that only ever sees what
// an output batch told it to.

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
import type { Codec, EncodedFrame, Frame, Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { defined } from '@platform/math';
import type { BreakerTrip, KVStore, LogSink } from '@platform/core';
import { PERSISTENCE_SCOPE } from '@platform/core';
import { Sim } from '../src/sim.js';
import type { SimConfig } from '../src/sim.js';
import type { ConnectionId, InputBatch, LoadedRecord, OutputBatch } from '../src/batch.js';

/** One client end. It speaks the wire and records everything it is told, and nothing else. */
export class Peer {
    readonly received: ServerToClient[] = [];
    readonly connectionId: ConnectionId;
    readonly #harness: Harness;
    #seq = 0;

    constructor(host: Harness, connectionId: ConnectionId) {
        this.#harness = host;
        this.connectionId = connectionId;
    }

    /**
     * The first frame on a connection — the client speaks first.
     *
     * Declares no project by default, which is what an unconfigured world declares too: the identity
     * check passes on agreement, not on absence, so a test that wants a mismatch says so.
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
        this.#harness.deliver(this.connectionId, message);
    }

    /** Drops this peer's socket, which the host reports as a close on the next tick. */
    close(): void {
        this.#harness.drop(this.connectionId);
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
        this.#harness.deliver(this.connectionId, envelope);
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

/**
 * A store the harness reads and writes through, so the load and save protocol is exercised rather
 * than stubbed.
 *
 * A rejected `get` is a FAILED read, which the sim treats differently from a store that simply held
 * nothing — the first must not be written over at the leave and the second must.
 */
export interface HarnessStore {
    get(hostKey: string): Promise<{ [field: string]: unknown } | null>;
    set(hostKey: string, fields: { [field: string]: unknown }): Promise<void>;
}

/** The default store: a map that answers on a resolved promise, which is still a turn later. */
export function memoryStore(): HarnessStore & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return {
        data,
        get: (hostKey) =>
            Promise.resolve((data.get(hostKey) as { [field: string]: unknown }) ?? null),
        set: (hostKey, fields) => {
            data.set(hostKey, fields);
            return Promise.resolve();
        },
    };
}

/** Core's `KVStore` as a harness store, so a test can assert against the store it handed in. */
export function kvStore(kv: KVStore): HarnessStore {
    return {
        get: (hostKey) =>
            kv
                .get(PERSISTENCE_SCOPE, hostKey)
                .then((v) => (v as { [field: string]: unknown } | undefined) ?? null),
        set: (hostKey, fields) => kv.set(PERSISTENCE_SCOPE, hostKey, fields),
    };
}

export interface HarnessOptions {
    config?: SimConfig;
    codec?: Codec;
    /** The dev channel, so a test can watch what the host would be told. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
    /** Where the world's decisions go, so a test reads exactly what an operator would grep. */
    log?: LogSink;
    /** Where persisted `@serverState` lives. Defaults to a map behind resolved promises. */
    store?: HarnessStore;
}

export class Harness {
    readonly sim: Sim;
    readonly store: HarnessStore;
    /** Every save the sim has ordered, in order — the host's obligation, made observable. */
    readonly saves: Array<{ hostKey: string; fields: { [field: string]: unknown } }> = [];
    /** Every close the sim has ordered, in order. */
    readonly closes: Array<{ connectionId: ConnectionId; reason: string }> = [];
    /** Every line the sim has emitted, in order. */
    readonly lines: string[] = [];

    readonly #peers = new Map<ConnectionId, Peer>();
    #opened: InputBatch['opened'] = [];
    #frames: InputBatch['frames'] = [];
    #closed: ConnectionId[] = [];
    #records: LoadedRecord[] = [];
    #saved: string[] = [];

    /** The most recent output batch, for a test that asserts on what the host was ordered to do. */
    lastOutput: OutputBatch | null = null;

    #nextConnectionId = 1;
    #sinceSend = 0;
    #nowMs = 0;
    #lastConnectionId: ConnectionId | null = null;

    constructor(opts: HarnessOptions = {}) {
        this.store = opts.store ?? memoryStore();
        this.sim = new Sim({
            ...defined({
                config: opts.config,
                codec: opts.codec,
                onBreakerTrip: opts.onBreakerTrip,
                log: opts.log,
            }),
        });
    }

    /** A new connection: the harness plays the host minting an id and offering it to the sim. */
    connect(playerId?: string): Peer {
        const connectionId = `c${this.#nextConnectionId++}`;
        this.#opened.push({ connectionId, identity: playerId ?? null });
        const peer = new Peer(this, connectionId);
        this.#peers.set(connectionId, peer);
        this.#lastConnectionId = this.sim.closed ? null : connectionId;
        return peer;
    }

    /** The id the most recent `connect()` was given, or null once the sim is closed. */
    get lastAcceptId(): ConnectionId | null {
        return this.#lastConnectionId;
    }

    get tick(): number {
        return this.sim.runtime.tick;
    }

    /** Host wall-clock in milliseconds, which only the two `serverSentMs` stamps ever read. */
    get nowMs(): number {
        return this.#nowMs;
    }

    /** Queues one frame for the next tick, the way a socket callback would. */
    deliver(connectionId: ConnectionId, message: unknown): void {
        this.#frames.push({ connectionId, message });
    }

    /** Reports a socket gone, the way a transport's close handler would. */
    drop(connectionId: ConnectionId): void {
        this.#closed.push(connectionId);
    }

    /**
     * `n` wakes of exactly one tick each — the ordinary case. Returns the sends they produced.
     *
     * The send cadence is counted here rather than derived from the tick index, which is what a host
     * does: a mid-session `setSimRate` must not be able to desync it.
     */
    pumpTicks(n = 1): number {
        const perSend = ticksPerSend(this.sim.config.simRate, this.sim.config.sendRate);
        let sends = 0;
        for (let i = 0; i < n; i++) {
            this.#nowMs += 1000 / this.sim.config.simRate;
            this.#sinceSend += 1;
            const drain = this.#sinceSend >= perSend;
            if (drain) this.#sinceSend = 0;
            this.#apply(this.sim.tick(this.#batch(drain)));
            if (drain) sends += 1;
        }
        return sends;
    }

    /** As many single ticks as `seconds` of wall-clock buys, for a test that thinks in the deadline's units. */
    pump(seconds: number): number {
        const ticks = Math.max(0, Math.round(seconds * this.sim.config.simRate));
        return this.pumpTicks(ticks);
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
     * Pumps until the Welcome arrives rather than a fixed count: the world answers a join at the next
     * SEND-tick, so the snapshot and the journal are cut at the same instant.
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
     * `joined`, for a host-named peer — whose admission waits on the store read the sim asked for.
     *
     * Flushes a macrotask per tick rather than only a microtask, so it settles against a store that
     * answers on a timer as well as one that resolves immediately.
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

    /** Releases the world and acts on the last batch, exactly as a host shutting down would. */
    close(): void {
        this.#apply(this.sim.close());
    }

    /** Settles once every write this harness started has landed — the host's shutdown drain. */
    async drain(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    #batch(drain: boolean): InputBatch {
        const batch: InputBatch = {
            nowMs: this.#nowMs,
            drain,
            opened: this.#opened,
            frames: this.#frames,
            closed: this.#closed,
            records: this.#records,
            saved: this.#saved,
        };
        this.#opened = [];
        this.#frames = [];
        this.#closed = [];
        this.#records = [];
        this.#saved = [];
        return batch;
    }

    /** Everything one output batch orders — the host's whole job, in the order it must happen. */
    #apply(out: OutputBatch): void {
        this.lastOutput = out;
        for (const line of out.log) this.lines.push(line.line);

        for (const send of out.sends) {
            for (const connectionId of send.to) {
                this.#peers.get(connectionId)?.received.push(send.envelope);
            }
        }

        for (const order of out.closes) {
            this.closes.push(order);
            this.#peers.delete(order.connectionId);
            if (order.connectionId === this.#lastConnectionId) this.#lastConnectionId = null;
        }

        for (const load of out.loads) {
            void this.store.get(load.hostKey).then(
                (fields) => {
                    // `{}` for a store that held nothing, so the leave still writes; `null` is
                    // reserved for the read that failed.
                    this.#records.push({
                        connectionId: load.connectionId,
                        fields: (fields ?? {}) as NonNullable<LoadedRecord['fields']>,
                    });
                },
                () => {
                    this.#records.push({ connectionId: load.connectionId, fields: null });
                },
            );
        }

        for (const save of out.saves) {
            this.saves.push({ hostKey: save.hostKey, fields: save.fields });
            void this.store.set(save.hostKey, save.fields).then(
                () => {
                    this.#saved.push(save.hostKey);
                },
                () => {},
            );
        }
    }
}

/** Ticks between broadcasts, never below one — the host's cadence, restated for the harness. */
function ticksPerSend(simRate: number, sendRate: number): number {
    if (!(sendRate > 0)) return 1;
    return Math.max(1, Math.round(simRate / sendRate));
}

export function harness(opts: HarnessOptions = {}): Harness {
    return new Harness(opts);
}

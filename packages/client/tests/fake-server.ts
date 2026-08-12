// A protocol-conformant peer over the other end of a loopbackPair.
//
// There is no second `GameClient` to gate, so the reusable suite is this: it answers a `JoinRequest`,
// emits envelopes on a scripted schedule, and acks. It makes every test a BLACK-BOX test of the real
// client, and it is what `@platform/server` can later run against to prove the two halves agree — the
// acceptance test for the pair, which neither package can write alone.

import type {
    ClientToServer,
    EntitySnapshot,
    InputFrame,
    NetId,
    PlayerSnapshot,
    Reject,
    RejectReason,
    RenderManifest,
    StateEnvelope,
    StateDiff,
    TransformDiff,
    TransformEnvelope,
    Welcome,
    WireStructuralOp,
    WireTransform,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { Message, Transport } from '@platform/transport';

export interface FakeServerOptions {
    simRate?: number;
    sendRate?: number;
    /** Answer the join with a `Reject` instead of a `Welcome`. */
    reject?: RejectReason;
    /** Send a structurally broken `Welcome` — the undecodable case. */
    malformedWelcome?: boolean;
    /** The tick the snapshot describes. */
    snapshotTick?: number;
    /** Entities in the join snapshot. PARENTS BEFORE CHILDREN is this peer's obligation. */
    entities?: EntitySnapshot[];
    players?: PlayerSnapshot[];
    state?: StateDiff[];
    /** Server wall-clock stamp, so a test can produce a chosen RTT. */
    serverSentMs?: number;
    /** Answers `TimeSync`. Default true. */
    answerTimeSync?: boolean;
    /** The welcome's `RenderManifest`. Defaults to empty, which asks the renderer for nothing. */
    visuals?: RenderManifest;
}

/** Every input frame this peer received, with the tick it arrived on — for headroom arithmetic. */
export interface ReceivedInput {
    frame: InputFrame;
    arrivedAtTick: number;
}

export class FakeServer {
    readonly #transport: Transport;
    readonly #opts: FakeServerOptions;

    readonly joins: Array<{ name: string; protocolVersion: number; token?: string }> = [];
    readonly inputs: ReceivedInput[] = [];
    readonly timeSyncs: number[] = [];
    /** Everything sent, in order — so a test can assert the first frame was a JoinRequest. */
    readonly received: ClientToServer[] = [];

    /** This peer's own tick, which a test advances. Inputs are measured against it. */
    tick = 0;
    #ackSeq = -1;
    #welcomed = false;

    constructor(transport: Transport, opts: FakeServerOptions = {}) {
        this.#transport = transport;
        this.#opts = opts;
        // A snapshot tick is the tick this peer IS at, not an unrelated number: the snapshot describes
        // the world now. Keeping the two in step matters because the client's counter seeds from the
        // snapshot and then measures every later envelope against it — a peer whose `tick` disagreed
        // with its own snapshot would send envelopes from the client's future and trip the behind-check
        // on the next frame, so the resync path would be under test everywhere by accident.
        if (opts.snapshotTick !== undefined) this.tick = opts.snapshotTick;
        transport.onMessage((message) => this.#receive(message));
    }

    get simRate(): number {
        return this.#opts.simRate ?? 60;
    }

    get sendRate(): number {
        return this.#opts.sendRate ?? 20;
    }

    get welcomed(): boolean {
        return this.#welcomed;
    }

    get ackSeq(): number {
        return this.#ackSeq;
    }

    #receive(message: Message): void {
        const envelope = message as unknown as ClientToServer;
        this.received.push(envelope);

        switch (envelope.kind) {
            case 'join-request': {
                const join: { name: string; protocolVersion: number; token?: string } = {
                    name: envelope.name,
                    protocolVersion: envelope.protocolVersion,
                };
                if (envelope.token !== undefined) join.token = envelope.token;
                this.joins.push(join);
                this.#answerJoin(envelope.clientSentMs);
                return;
            }
            case 'input':
                this.inputs.push({ frame: envelope, arrivedAtTick: this.tick });
                return;
            case 'time-sync':
                this.timeSyncs.push(envelope.clientSentMs);
                if (this.#opts.answerTimeSync !== false) {
                    this.#send({
                        kind: 'time-sync-reply',
                        clientSentMs: envelope.clientSentMs,
                        serverSentMs: this.#opts.serverSentMs ?? envelope.clientSentMs,
                        serverTick: this.tick,
                    });
                }
                return;
        }
    }

    #answerJoin(clientSentMs: number): void {
        if (this.#opts.reject !== undefined) {
            const reject: Reject = {
                kind: 'reject',
                reason: this.#opts.reject,
                serverProtocolVersion: PROTOCOL_VERSION,
            };
            this.#send(reject);
            this.#transport.close();
            return;
        }

        if (this.#opts.malformedWelcome === true) {
            // A `Welcome` that fails to decode — here, one whose required fields are the wrong shape,
            // which is what a codec mismatch looks like once the frame is parsed at all.
            this.#send({ kind: 'welcome' } as unknown as Welcome);
            return;
        }

        const welcome: Welcome = {
            kind: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            yourPlayerId: 'p1',
            yourPlayerIndex: 0,
            simRate: this.simRate,
            sendRate: this.sendRate,
            bounds: { left: -400, right: 400, top: 300, bottom: -300 },
            regions: [],
            clientSentMs,
            serverSentMs: this.#opts.serverSentMs ?? clientSentMs,
            snapshot: {
                // This peer's tick NOW, never a fixed number: a snapshot describes the world at the
                // moment it is built, and one carrying a tick its sender has already passed is stale
                // against its own clock — which reads to the client as a counter that has fallen behind
                // and resyncs. `snapshotTick` seeds `this.tick` in the constructor instead.
                tick: this.tick,
                entities: this.#opts.entities ?? [],
                players: this.#opts.players ?? [{ id: 'p1', index: 0, name: 'p1' }],
                state: this.#opts.state ?? [],
            },
            visuals: this.#opts.visuals ?? { assets: [], templates: [] },
        };
        this.#welcomed = true;
        this.#send(welcome);
    }

    /** Sends a frame this peer would never build, for the client's boundary checks. */
    sendRaw(envelope: unknown): void {
        this.#send(envelope);
    }

    /**
     * One send-tick's reliable envelope. Sent even when empty — a wire rule, since a transform envelope
     * in a quiet tick would otherwise have no counterpart and never apply.
     */
    sendState(
        structural: WireStructuralOp[] = [],
        state: StateDiff[] = [],
        opts: { tick?: number; ackSeq?: number; headroom?: number } = {},
    ): void {
        const envelope: StateEnvelope = {
            kind: 'state',
            tick: opts.tick ?? this.tick,
            ackSeq: opts.ackSeq ?? this.#ackSeq,
            structural,
            state,
        };
        if (opts.headroom !== undefined) envelope.earliestHeadroom = opts.headroom;
        this.#send(envelope);
    }

    sendTransforms(transform: TransformDiff[], tick = this.tick): void {
        const envelope: TransformEnvelope = { kind: 'transform', tick, transform };
        this.#send(envelope);
    }

    /**
     * Resolves every input received so far and reports the headroom of the EARLIEST one — the arithmetic
     * the lead loop needs: `frame.tick - serverTickOnArrival` for the earliest input in the batch.
     */
    ackAll(opts: { tick?: number } = {}): void {
        const pending = this.inputs.filter((i) => i.frame.seq > this.#ackSeq);
        if (pending.length === 0) {
            this.sendState([], [], opts);
            return;
        }
        const earliest = pending.reduce((a, b) => (a.frame.seq <= b.frame.seq ? a : b));
        const last = pending.reduce((a, b) => (a.frame.seq >= b.frame.seq ? a : b));
        this.#ackSeq = last.frame.seq;
        this.sendState([], [], {
            ...opts,
            ackSeq: this.#ackSeq,
            headroom: earliest.frame.tick - earliest.arrivedAtTick,
        });
    }

    /** Acks with a headroom a test dictates, for driving the loop to a chosen operating point. */
    ackWithHeadroom(headroom: number, opts: { tick?: number } = {}): void {
        const pending = this.inputs.filter((i) => i.frame.seq > this.#ackSeq);
        if (pending.length === 0) return;
        const last = pending.reduce((a, b) => (a.frame.seq >= b.frame.seq ? a : b));
        this.#ackSeq = last.frame.seq;
        this.sendState([], [], { ...opts, ackSeq: this.#ackSeq, headroom });
    }

    sendRateChange(simRate: number, tick = this.tick): void {
        this.#send({ kind: 'rate-change', tick, simRate });
    }

    close(): void {
        this.#transport.close();
    }

    #send(envelope: unknown): void {
        this.#transport.send(envelope as Message);
    }
}

export function wireTransform(over: Partial<WireTransform> = {}): WireTransform {
    return {
        posX: 0,
        posY: 0,
        posZ: 0,
        rot: 0,
        scale: 1,
        opacity: 1,
        layer: 0,
        ...over,
    };
}

export function entity(
    netId: number,
    template = 'thing',
    over: Partial<Omit<EntitySnapshot, 'netId' | 'template'>> = {},
): EntitySnapshot {
    return {
        netId: netId as NetId,
        template,
        parent: over.parent ?? null,
        owner: over.owner ?? null,
        tags: over.tags ?? [],
        transform: over.transform ?? wireTransform(),
    };
}

export function transformDiff(netId: number, over: Partial<WireTransform> = {}): TransformDiff {
    return { netId: netId as NetId, ...wireTransform(over) };
}

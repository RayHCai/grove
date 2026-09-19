// A protocol-conformant peer over the far end of a `loopbackPair`, for black-box client tests.

import { defined } from '@platform/math';
import type { TemplateId } from '@platform/project';
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
    /** Accept the connection and answer nothing at all — the peer that never gets round to it. */
    ignoreJoin?: boolean;
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
    /** What this peer claims to be running; declares nothing by default, as the client matches. */
    project?: { projectId: string; projectHash: string };
    /** Names a script bundle in the welcome, so the client fetches before it goes live. */
    bundle?: { url: string; hash: string };
    /**
     * Divides the snapshot's entities across this many `snapshot-chunk` frames sent ahead of the
     * `Welcome` — what a real server does for a world one frame cannot carry.
     */
    snapshotChunks?: number;
    /** Sends a count the chunks do not add up to, for the short-set refusal. */
    understateChunkCount?: boolean;
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
    /** True once the other end closed the connection, which is how a test sees a client give up. */
    closed = false;
    #ackSeq = -1;
    #welcomed = false;
    #welcome: Welcome | undefined;

    constructor(transport: Transport, opts: FakeServerOptions = {}) {
        this.#transport = transport;
        this.#opts = opts;
        // A snapshot tick is the tick this peer IS at: the client's counter seeds from the snapshot
        // and measures every later envelope against it.
        if (opts.snapshotTick !== undefined) this.tick = opts.snapshotTick;
        transport.onMessage((message) => this.#receive(message));
        transport.onClose(() => {
            this.closed = true;
        });
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

    /** The welcome this peer sent, so a test can name the tick the client's counter seeded from. */
    get welcome(): Welcome | undefined {
        return this.#welcome;
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
                    });
                }
                return;
        }
    }

    #answerJoin(clientSentMs: number): void {
        if (this.#opts.ignoreJoin === true) return;
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
            // A `Welcome` that fails to decode: required fields the wrong shape, as a codec
            // mismatch.
            this.#send({ kind: 'welcome' } as unknown as Welcome);
            return;
        }

        const welcome: Welcome = {
            kind: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            yourPlayerId: 'p1',
            yourPlayerIndex: 0,
            projectId: this.#opts.project?.projectId ?? '',
            projectHash: this.#opts.project?.projectHash ?? '',
            bundleHash: this.#opts.bundle?.hash ?? '',
            bundleUrl: this.#opts.bundle?.url ?? '',
            simRate: this.simRate,
            sendRate: this.sendRate,
            bounds: { left: -400, right: 400, top: 300, bottom: -300 },
            regions: [],
            clientSentMs,
            serverSentMs: this.#opts.serverSentMs ?? clientSentMs,
            snapshot: {
                // This peer's tick NOW, never a fixed number: a snapshot with a passed tick is
                // stale against its own clock and reads as falling behind.
                tick: this.tick,
                entities: this.#opts.entities ?? [],
                players: this.#opts.players ?? [{ id: 'p1', index: 0, name: 'p1' }],
                state: this.#opts.state ?? [],
            },
            visuals: this.#opts.visuals ?? { assets: [], templates: [] },
        };
        this.#chunkSnapshot(welcome);
        this.#welcomed = true;
        this.#welcome = welcome;
        this.#send(welcome);
    }

    /** Moves the snapshot's entities into `snapshot-chunk` frames sent ahead of the `Welcome`. */
    #chunkSnapshot(welcome: Welcome): void {
        const count = this.#opts.snapshotChunks ?? 0;
        if (count <= 0) return;

        const all = welcome.snapshot.entities;
        const per = Math.ceil(all.length / count);
        welcome.snapshot.entities = [];
        for (let index = 0; index < count; index++) {
            this.#send({
                kind: 'snapshot-chunk',
                index,
                entities: all.slice(index * per, (index + 1) * per),
                state: [],
            });
        }
        welcome.snapshotChunks = this.#opts.understateChunkCount === true ? count - 1 : count;
    }

    /** Sends a frame this peer would never build, for the client's boundary checks. */
    sendRaw(envelope: unknown): void {
        this.#send(envelope);
    }

    /** One send-tick's reliable envelope. Sent even when empty — a wire rule. */
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

    /** Resolves every input so far, reporting the EARLIEST one's headroom for the lead loop. */
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

    sendRateChange(simRate: number): void {
        this.#send({ kind: 'rate-change', simRate });
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
    id: number,
    template = 'thing',
    over: Partial<Omit<EntitySnapshot, 'netId' | 'template'>> = {},
): EntitySnapshot {
    return {
        netId: netId(id),
        template: template as TemplateId,
        parent: over.parent ?? null,
        owner: over.owner ?? null,
        tags: over.tags ?? [],
        transform: over.transform ?? wireTransform(),
        ...defined({ overrides: over.overrides }),
    };
}

export function transformDiff(id: number, over: Partial<WireTransform> = {}): TransformDiff {
    return { netId: netId(id), ...wireTransform(over) };
}

/** A netId as the wire spells it. Minted here because only a fake peer mints one. */
export function netId(n: number): NetId {
    return n as NetId;
}

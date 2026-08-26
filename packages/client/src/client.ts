// GameClient: the frame order, and the one place every seam meets.
//
// The loop body is `frame(nowSeconds)` and what calls it is injected, so a Node test drives whole seconds
// with no rAF, no canvas and no socket. A React app composes rather than competes: a hook that owns the
// renderer's lifecycle calls `client.frame(now)` from its own rAF loop, so the hook is the `FrameSource`.

import type { ActionStates, EntityId, Player } from '@platform/core';
import { clearRuntime, createActionStates, currentRuntime, hasRuntime } from '@platform/core';
import type { CameraState, IRenderer } from '@platform/renderer';
import type {
    InputAction,
    InputFrame,
    NetId,
    RateChange,
    ServerToClient,
    StateEnvelope,
    TimeSyncReply,
    Welcome,
} from '@platform/protocol';
import type { Message, Transport } from '@platform/transport';
import { TransportError } from '@platform/transport';
import {
    ACK_STALL_TICKS,
    DEFAULT_VIEWPORT,
    STALL_SECONDS,
    SYNC_INTERVAL_SECONDS,
} from './constants.js';
import { BindingTable } from './bindings.js';
import type { Binding, ResolvedEdge } from './bindings.js';
import { ClientClock } from './clock.js';
import { RenderBridge } from './bridge.js';
import {
    asServerEnvelope,
    isUsableWelcome,
    joinRequest,
    rejectMessage,
    rttSeconds,
    send,
    timeSync,
} from './handshake.js';
import type { ClockSource } from './handshake.js';
import type { FrameSource, InputDevice, RawInputEvent } from './input.js';
import { Lifecycle } from './lifecycle.js';
import type { SessionState } from './lifecycle.js';
import { Mirror, wireBounds } from './mirror.js';
import type { MirrorDelta, TemplateScripts } from './mirror.js';
import { Prediction } from './prediction.js';
import { InputRing } from './ring.js';

const CAMERA_ORIGIN = { x: 0, y: 0, z: 0 } as const;

export interface GameClientOptions {
    transport: Transport;
    renderer: IRenderer;
    frames: FrameSource;
    device: InputDevice;
    clock: ClockSource;
    /** Display name. Untrusted upward — the server sanitizes and may replace it. */
    name: string;
    bindings?: readonly Binding[];
    /** Held for a later reconnect; carried now so adding one needs no envelope change. */
    token?: string;
    /** Pumps a loopback pair at the top of the frame. Absent for a real socket, which self-delivers. */
    pump?: () => void;
    /** Resolves the camera each frame from the local player. Defaults to the player's core `Camera`. */
    camera?: (player: Player | null) => CameraState;
    /**
     * Simulates the local player's own entities ahead of the server, replaying unacked input over every
     * authoritative delta. Off by default: what it runs is the creator scripts attached to those
     * entities, and a mirror holding none predicts an unchanged world at the cost of the replay.
     */
    predict?: boolean;
    /** The scripts a spawned entity gets here, by template — what `predict` has to run. */
    scripts?: TemplateScripts;
}

/** What a dev console asks about, which a tick count does not answer. */
export interface ClientStats {
    state: SessionState;
    localTick: number;
    depictedTick: number;
    rttSeconds: number;
    targetLeadSeconds: number;
    currentLeadSeconds: number;
    ringSize: number;
    droppedToOverflow: number;
    unknownNetId: number;
    outOfOrderParent: number;
    nodeCount: number;
    /** Manifest loads that rejected. Nonzero means some art is drawing as a placeholder. */
    assetLoadFailed: number;
    /** Where the predicted world stands. Equal to `depictedTick` when nothing is predicted. */
    predictedTick: number;
    /** Rewind-and-replay cycles: one per frame that carried authoritative state. */
    resimulations: number;
    /** Replays that hit the tick cap, so the predicted world skipped ticks the server did not. */
    cappedReplays: number;
}

export class GameClient {
    readonly #opts: GameClientOptions;
    readonly #lifecycle = new Lifecycle();
    readonly #bindings: BindingTable;
    readonly #ring = new InputRing();
    /** The local player's live action state — what a resync rebuilds the horizon from. */
    readonly #actions: ActionStates = createActionStates();

    #mirror: Mirror | undefined;
    #bridge: RenderBridge | undefined;
    #clock: ClientClock | undefined;
    #welcome: Welcome | undefined;
    #prediction: Prediction | undefined;
    /** Authoritative state landed this frame, so the predicted span has to be re-run over it. */
    #resimulate = false;

    readonly #disposers: Array<() => void> = [];

    /** Envelopes delivered since the last frame — drained in arrival order. */
    readonly #inbox: ServerToClient[] = [];

    #seq = 0;
    /** Edges resolved but not yet framed: coalesced per (action, tick) at flush. */
    readonly #pending: ResolvedEdge[] = [];

    #rtt = 0;
    /** Our own send stamps, in the injected clock's ms — never the value the server echoed back. */
    #joinSentMs = 0;
    #lastSyncSentMs: number | undefined;
    /** All four of these are in the FRAME source's seconds, which is the only base `#now` ever holds. */
    #now = 0;
    #lastEnvelopeAt: number | undefined;
    #lastSyncAt = 0;
    #ackSeqStillAt = 0;
    #ackSeq = -1;
    #assetLoadFailed = 0;
    /** Set by a resync, cleared when input resumes: only a re-join needs held state re-asserted. */
    #rejoined = false;
    #torn = false;

    /** Scratch for the tick indices one frame advanced. */
    readonly #ticks: number[] = [];
    readonly #edges: ResolvedEdge[] = [];

    constructor(opts: GameClientOptions) {
        this.#opts = opts;
        this.#bindings = new BindingTable(opts.bindings ?? []);
    }

    get state(): SessionState {
        return this.#lifecycle.state;
    }

    get lifecycle(): Lifecycle {
        return this.#lifecycle;
    }

    get mirror(): Mirror | undefined {
        return this.#mirror;
    }

    get bindings(): BindingTable {
        return this.#bindings;
    }

    get ring(): InputRing {
        return this.#ring;
    }

    get clock(): ClientClock | undefined {
        return this.#clock;
    }

    get actions(): ActionStates {
        return this.#actions;
    }

    /** The local player, once the roster carries them. */
    get localPlayer(): Player | null {
        const id = this.#welcome?.yourPlayerId;
        if (id === undefined) return null;
        return this.#mirror?.runtime.playerManager?.byId(id) ?? null;
    }

    get prediction(): Prediction | undefined {
        return this.#prediction;
    }

    stats(): ClientStats {
        const counters = this.#mirror?.counters;
        const predicted = this.#prediction;
        const depictedTick = this.#mirror?.depictedTick ?? 0;
        const predictedTick = predicted?.predictedTick ?? -1;
        return {
            state: this.#lifecycle.state,
            localTick: this.#clock?.localTick ?? 0,
            depictedTick,
            rttSeconds: this.#rtt,
            targetLeadSeconds: this.#clock?.targetLeadSeconds ?? 0,
            currentLeadSeconds: this.#clock?.currentLeadSeconds ?? 0,
            ringSize: this.#ring.size,
            droppedToOverflow: this.#ring.droppedToOverflow,
            unknownNetId: counters?.unknownNetId ?? 0,
            outOfOrderParent: counters?.outOfOrderParent ?? 0,
            nodeCount: this.#bridge?.nodeCount ?? 0,
            assetLoadFailed: this.#assetLoadFailed,
            predictedTick: predictedTick < 0 ? depictedTick : predictedTick,
            resimulations: predicted?.counters.resimulations ?? 0,
            cappedReplays: predicted?.counters.cappedReplays ?? 0,
        };
    }

    /** Handlers register before the send, so ordering never depends on transport's retention rule. */
    start(): void {
        const { transport, device, frames } = this.#opts;

        this.#disposers.push(transport.onMessage((message) => this.#receive(message)));
        this.#disposers.push(
            transport.onClose(() => {
                this.#lifecycle.to('disconnected');
                frames.stop();
            }),
        );
        this.#disposers.push(device.onRaw((event) => this.#onRaw(event)));

        this.#joinSentMs = this.#opts.clock.nowSeconds() * 1000;
        this.#guard(() =>
            send(transport, joinRequest(this.#opts.name, this.#joinSentMs, this.#opts.token)),
        );

        frames.start((now) => this.frame(now));
    }

    /** One display frame: drain inbound, step the clock, enqueue outbound, push to the renderer. */
    frame(nowSeconds: number): void {
        if (this.#torn) return;
        this.#now = nowSeconds;

        this.#opts.pump?.();

        // Order-sensitive: one `deliver()` routinely hands over several envelopes, and the bridge consumes
        // their deltas in the same order rather than merging them.
        this.#drainInbox();

        // 0..N ticks. The push is below rather than inside this, because it is display work at display
        // rate: a frame that advanced three ticks still pushes once.
        if (this.#lifecycle.state !== 'failed' && this.#clock !== undefined) {
            this.#clock.advance(nowSeconds, this.#ticks);
            this.#flushInput(this.#ticks);
        }

        // After the flush, so the tick just stamped can be replayed on the frame it was sent.
        this.#predict();

        this.#checkNotBehind();
        this.#checkLiveness();
        this.#maybeSync();

        if (this.#bridge !== undefined) {
            this.#bridge.pushTransforms(nowSeconds);
            this.#bridge.pushCamera(this.#cameraState());
        }
        this.#opts.renderer.render();
    }

    /**
     * Carries the predicted world up to the local tick.
     *
     * Only while `live`: `stalled` refuses input, and simulating on through it would run the avatar off
     * held keys with nothing arriving to correct it — ghost gameplay by another route. A `resimulate`
     * dropped here is not lost, because the next envelope raises it again.
     */
    #predict(): void {
        const resimulate = this.#resimulate;
        this.#resimulate = false;
        const prediction = this.#prediction;
        const clock = this.#clock;
        if (prediction === undefined || clock === undefined) return;
        if (this.#lifecycle.state !== 'live') return;
        prediction.advance(clock.localTick, resimulate);
    }

    #receive(message: Message): void {
        const envelope = asServerEnvelope(message);
        // A frame that is not an envelope, or one missing a field the client dereferences, is a mismatched
        // or hostile peer: dropped rather than crashing the session.
        if (envelope === undefined) return;
        this.#inbox.push(envelope);
    }

    #drainInbox(): void {
        if (this.#inbox.length === 0) return;
        const batch = this.#inbox.splice(0);
        this.#lastEnvelopeAt = this.#now;

        // Once, ahead of the batch's first authoritative write rather than inside it: a delta names only
        // what changed, so a field it does not mention would keep its predicted value and never converge.
        if (this.#prediction !== undefined && batch.some(isAuthoritative)) {
            this.#prediction.rewind();
            this.#resimulate = true;
        }

        for (const envelope of batch) {
            // Nothing after a terminal failure can matter, and applying into a half-torn session is how a
            // second fault gets reported instead of the first.
            if (this.#lifecycle.state === 'failed') return;
            try {
                this.#dispatch(envelope);
            } catch (error) {
                // An envelope that passed the boundary narrowing and still threw is malformed deeper than
                // depth-one checks reach. Failing here names the peer; letting it unwind would escape
                // `frame()` through the frame source and end the session with nothing to show a person.
                this.#lifecycle.fail({
                    kind: 'peer',
                    message: error instanceof Error ? error.message : String(error),
                });
                this.#opts.frames.stop();
                return;
            }
        }
    }

    #dispatch(envelope: ServerToClient): void {
        switch (envelope.kind) {
            case 'welcome':
                this.#onWelcome(envelope);
                return;
            case 'reject':
                this.#lifecycle.fail({
                    kind: 'rejected',
                    reason: rejectMessage(envelope),
                    serverProtocolVersion: envelope.serverProtocolVersion,
                });
                this.#opts.frames.stop();
                return;
            case 'state':
                this.#onState(envelope);
                return;
            case 'transform':
                this.#mirror?.applyTransforms(envelope);
                return;
            case 'time-sync-reply':
                this.#onTimeSyncReply(envelope);
                return;
            case 'rate-change':
                this.#onRateChange(envelope);
                return;
        }
    }

    #onWelcome(welcome: Welcome): void {
        // No envelope is accepted before the Welcome, and a second one is ignored: the mirror it would
        // rebuild is the resync path's, which goes through `#resync`.
        if (this.#welcome !== undefined) return;
        if (!isUsableWelcome(welcome)) {
            // A `Welcome` the client cannot use means the server does not speak this client's JSON —
            // terminal, and distinct from a `Reject`, which carries a reason.
            this.#lifecycle.fail({ kind: 'undecodable' });
            this.#opts.frames.stop();
            return;
        }

        this.#welcome = welcome;
        // Measured against the stamp we recorded at send, on the clock that produced it: the echoed
        // `clientSentMs` is peer-controlled, and reading it would let a server dictate our lead.
        this.#rtt = rttSeconds(this.#opts.clock.nowSeconds() * 1000, this.#joinSentMs);

        this.#mirror = new Mirror({
            simRate: welcome.simRate,
            bounds: wireBounds(welcome.bounds),
            regions: welcome.regions.map((r) => ({ name: r.name, bounds: wireBounds(r.bounds) })),
            ...(this.#opts.scripts === undefined ? {} : { scripts: this.#opts.scripts }),
        });
        // `sendRate` is the interval between transforms, and so the interval the render path buffers over:
        // without it an entity nothing local predicts holds its pose until the next envelope.
        this.#bridge = new RenderBridge(this.#opts.renderer, this.#mirror.view(), welcome.sendRate);
        // Started, not awaited: the template table fills synchronously, so the snapshot below resolves
        // every template. A rejection means missing art, which the renderer already draws as a
        // placeholder — so it is counted rather than allowed to become an unhandled rejection.
        this.#bridge.loadManifest(welcome.visuals).catch(() => {
            this.#assetLoadFailed++;
        });

        // The snapshot's tick seeds the counter and the RTT seeds the lead — and because the tick rides
        // `snapshot.tick` rather than a field of its own, the tick the counter seeds from and the tick its
        // initial world describes cannot disagree.
        this.#clock = new ClientClock({
            simRate: welcome.simRate,
            snapshotTick: welcome.snapshot.tick,
            rttSeconds: this.#rtt,
        });

        this.#apply(this.#mirror.applySnapshot(welcome));
        this.#mirror.runtime.localPlayer = this.localPlayer;

        if (this.#opts.predict === true) {
            this.#prediction = new Prediction({
                mirror: this.#mirror,
                ring: this.#ring,
                bridge: this.#bridge,
                playerId: welcome.yourPlayerId,
            });
            this.#mirror.simulate(this.#prediction.context);
            // Handed over live: the scope is refilled in place whenever authoritative state lands, and an
            // entity this replays is one the buffer must leave alone — two smoothers rubber-band.
            this.#bridge.setPredicted(this.#prediction.scope);
            // The snapshot is authoritative state, so this frame already has a baseline to replay over.
            this.#resimulate = true;
        }

        this.#lastSyncAt = this.#now;
        // Both liveness clocks start at the welcome, not at time zero: a join that took a moment must not
        // be charged against the first ack's deadline.
        this.#ackSeqStillAt = this.#now;
        this.#lifecycle.to('live');
        this.#resumeInput();
    }

    #onState(envelope: StateEnvelope): void {
        const mirror = this.#mirror;
        const clock = this.#clock;
        if (mirror === undefined || clock === undefined) return;

        this.#apply(mirror.applyState(envelope));

        // The ack: prune the ring, then steer the lead off the sample describing the earliest frame this
        // ack resolved.
        if (envelope.ackSeq > this.#ackSeq) {
            this.#ackSeq = envelope.ackSeq;
            this.#ackSeqStillAt = this.#now;
            const earliest = this.#ring.ack(envelope.ackSeq);
            const headroom = envelope.earliestHeadroom;
            // Recovery is defined on the ring, not on arrival: an ack arriving after a stall describes a
            // frame sent before it, and reads deeply negative because nothing was being processed.
            if (
                earliest !== undefined &&
                headroom !== undefined &&
                earliest.epoch === clock.epoch
            ) {
                clock.sample({ headroom, leadAtSendTicks: earliest.leadAtSendTicks });
            }
        }

        // The behind-check and stall recovery deliberately do not run here, though this is where the
        // depicted tick changes: see `#checkNotBehind` and `#checkLiveness`.
    }

    #onTimeSyncReply(reply: TimeSyncReply): void {
        // Only a reply echoing the stamp we sent is ours; the interval is measured off our own clock.
        const sentMs = this.#lastSyncSentMs;
        if (sentMs === undefined || reply.clientSentMs !== sentMs) return;
        this.#lastSyncSentMs = undefined;
        this.#rtt = rttSeconds(this.#opts.clock.nowSeconds() * 1000, sentMs);
    }

    #onRateChange(change: RateChange): void {
        // A resync rather than a live retune, because core retunes neither a pending timer's schedule, the
        // lag ring's size, nor an already-stamped input frame's meaning.
        if (this.#welcome === undefined) return;
        this.#welcome = { ...this.#welcome, simRate: change.simRate };
        this.#resync();
    }

    #apply(delta: MirrorDelta): void {
        this.#bridge?.reconcile(delta);
    }

    #onRaw(event: RawInputEvent): void {
        const viewport = this.#bridge?.viewport ?? DEFAULT_VIEWPORT;
        this.#bindings.resolve(event, viewport, this.#edges);
        if (this.#edges.length === 0) return;

        if (event.kind === 'focusLost') {
            // Immediately, not from the frame loop: a hidden tab stops being driven, so a release left for
            // the next frame waits until the player returns. Exempt from the `stalled` refusal too.
            this.#pending.push(...this.#edges);
            this.#flushInput(this.#clock === undefined ? [] : [this.#clock.localTick], true);
            return;
        }

        if (!this.#lifecycle.acceptsInput) return;
        this.#pending.push(...this.#edges);
    }

    /**
     * Frames the pending edges for the ticks just advanced and sends them — one frame per tick carrying
     * every action for that tick, which is what makes `seq` and `tick` advance together so `ackSeq` names
     * a tick boundary.
     *
     * Empty frames are not sent.
     */
    #flushInput(ticks: readonly number[], force = false): void {
        const clock = this.#clock;
        if (clock === undefined) return;
        if (!force && !this.#lifecycle.acceptsInput) {
            // Dropped rather than held: they are stamped against a tick the server will refuse as too old.
            this.#pending.length = 0;
            return;
        }
        const tick = ticks.at(-1);
        if (tick === undefined) return;

        // Every edge since the last flush belongs to the last tick advanced — the earliest it could apply on.
        this.#actions.advanceTick();
        if (this.#pending.length === 0) return;

        // One entry per (action, phase), coalesced — which is also what makes the batch well-formed.
        const byAction = new Map<string, InputAction>();
        for (const edge of this.#pending) {
            const action: InputAction = { action: edge.action, on: edge.on };
            if (edge.value !== undefined) action.value = edge.value;
            byAction.set(`${edge.action} ${edge.on}`, action);
            this.#actions.applyEdge(edge);
        }
        this.#pending.length = 0;

        const frame: InputFrame = {
            kind: 'input',
            tick,
            seq: this.#seq++,
            actions: [...byAction.values()],
        };
        this.#ring.push(frame, clock.currentLeadTicks, clock.epoch);
        this.#guard(() => send(this.#opts.transport, frame));
    }

    /**
     * Input resumed, so what the wire believes is stale: nothing was sent while it was refused.
     *
     * An axis re-asserts unconditionally, because a `hold` is idempotent. A press re-asserts only after a
     * re-join, where the server's session holds nothing — after a stall it still holds it, and a second
     * press would dispatch a spurious edge.
     */
    #resumeInput(): void {
        this.#bindings.forgetSentValues();
        for (const { action, value } of this.#actions.axisValues()) {
            this.#pending.push({ action, on: 'hold', value });
        }
        if (!this.#rejoined) return;
        this.#rejoined = false;
        for (const action of this.#actions.heldActions()) {
            this.#pending.push({ action, on: 'press' });
        }
    }

    /**
     * The counter must lead the depicted tick, or it has left the timeline entirely.
     *
     * Once per frame rather than once per apply, so the counter has been credited this frame's tick first —
     * checking at drain time resyncs a healthy session on ordinary accumulator phase drift.
     */
    #checkNotBehind(): void {
        const clock = this.#clock;
        const mirror = this.#mirror;
        if (clock === undefined || mirror === undefined) return;
        if (this.#lifecycle.state !== 'live' && this.#lifecycle.state !== 'stalled') return;
        if (clock.isBehind(mirror.depictedTick)) this.#resync();
    }

    /**
     * The single decider for `stalled`, in both directions — which is what keeps recovery honest.
     *
     * A drought is the server not sending; a frozen `ackSeq` is the server not processing. Recovering on any
     * inbound envelope would cure the second with traffic that did not advance the ack. Ring occupancy is
     * deliberately not a trigger — it would let an energetic player disable their own controls.
     */
    #checkLiveness(): void {
        const state = this.#lifecycle.state;
        if (state !== 'live' && state !== 'stalled') return;

        const since = this.#lastEnvelopeAt;
        const drought = since !== undefined && this.#now - since >= STALL_SECONDS;

        // In the session's own ticks, not frames: counting frames fires 7× early on 144 Hz over a 20 Hz sim.
        const simRate = this.#clock?.simRate ?? 60;
        const ackFrozen =
            this.#ring.size > 0 && this.#now - this.#ackSeqStillAt >= ACK_STALL_TICKS / simRate;

        if (drought || ackFrozen) this.#stall();
        else if (state === 'stalled') {
            this.#lifecycle.to('live');
            this.#resumeInput();
        }
    }

    #stall(): void {
        if (this.#lifecycle.state === 'stalled') return;
        this.#lifecycle.to('stalled');
        // This stall's samples describe starved batches, discarded by epoch rather than by arrival time.
        this.#clock?.bumpEpoch();
    }

    #maybeSync(): void {
        if (this.#lifecycle.state !== 'live') return;
        if (this.#now - this.#lastSyncAt < SYNC_INTERVAL_SECONDS) return;
        this.#lastSyncAt = this.#now;
        const sentMs = this.#opts.clock.nowSeconds() * 1000;
        this.#lastSyncSentMs = sentMs;
        this.#guard(() => send(this.#opts.transport, timeSync(sentMs)));
    }

    /**
     * Re-runs the join and applies a fresh snapshot through the one path.
     *
     * A resync rather than a counter repair: a 30 s suspension leaves the mirror 30 s stale too, so fixing
     * the counter alone yields a correctly clocked client rendering an abandoned world — worse, because it
     * looks like it worked. It also adds no mechanism that could break the tick sequence.
     */
    #resync(): void {
        this.#lifecycle.to('resyncing');
        this.#clock?.bumpEpoch();

        const delta = this.#mirror?.reset();
        if (delta !== undefined) this.#apply(delta);
        // The replacement bridge must start from an empty namespace, hierarchy included.
        this.#bridge?.clear();

        // The horizon rebuilds from live action state: what is physically held did not change because the
        // session's clock did.
        this.#ring.reset(this.#actions);
        this.#pending.length = 0;
        this.#ackSeq = -1;
        this.#ackSeqStillAt = this.#now;
        this.#lastEnvelopeAt = this.#now;
        this.#lastSyncSentMs = undefined;
        this.#welcome = undefined;
        this.#mirror = undefined;
        this.#bridge = undefined;
        this.#clock = undefined;
        // Dropped with the runtime it belongs to: a baseline holds handles that mean nothing in the next.
        this.#prediction = undefined;
        this.#resimulate = false;
        // The new session will hold nothing, so what is physically held has to be said again.
        this.#rejoined = true;

        this.#joinSentMs = this.#opts.clock.nowSeconds() * 1000;
        this.#guard(() =>
            send(
                this.#opts.transport,
                joinRequest(this.#opts.name, this.#joinSentMs, this.#opts.token),
            ),
        );
    }

    /** Core's `Camera` holds the intent; this resolves it per frame; the renderer draws it. */
    #cameraState(): CameraState {
        const resolve = this.#opts.camera;
        if (resolve !== undefined) return resolve(this.localPlayer);

        const player = this.localPlayer;
        if (player === null) return { position: CAMERA_ORIGIN, zoom: 1 };

        const camera = player.camera;
        const target = camera.followTarget;
        const bridge = this.#bridge;
        if (target !== null && bridge !== undefined && 'entityId' in target) {
            const local: EntityId = target.entityId;
            // The drawn position, not the simulated one: a camera locked to the exact answer slides its
            // target across the screen — while a predicted avatar eases towards a correction, and by a
            // whole send interval for a target the interpolation buffer draws.
            const drawn = bridge.drawnPosition(local);
            return { position: { x: drawn.x, y: drawn.y, z: 0 }, zoom: camera.zoom };
        }
        return { position: camera.position, zoom: camera.zoom };
    }

    /**
     * Reverse of setup, and idempotent throughout — a `failed` teardown and an unmount race.
     *
     * `ownsRenderer` defaults false: a host that built the renderer destroys it itself, and doing it here
     * would race that teardown.
     */
    destroy(opts: { ownsRenderer?: boolean } = {}): void {
        if (this.#torn) return;
        this.#torn = true;

        const runtime = this.#mirror?.runtime;

        this.#opts.frames.stop();
        this.#opts.device.dispose();
        for (const dispose of this.#disposers.splice(0)) dispose();
        this.#opts.transport.close();
        this.#bridge?.clear();
        if (opts.ownsRenderer === true) this.#opts.renderer.destroy();
        this.#mirror = undefined;
        this.#bridge = undefined;
        this.#prediction = undefined;

        // Only if the slot still holds ours: core keeps one module-global, and a second client — or a server
        // in this process — would otherwise lose its own to our teardown.
        if (runtime !== undefined && hasRuntime() && currentRuntime() === runtime) clearRuntime();
    }

    /** Maps a `TransportError` onto a failure state: `encode-rejected` is ours, the rest are the peer's. */
    #guard(fn: () => void): void {
        try {
            fn();
        } catch (error) {
            if (!(error instanceof TransportError)) throw error;
            this.#lifecycle.fail(
                error.code === 'encode-rejected'
                    ? { kind: 'internal', message: error.message }
                    : { kind: 'peer', message: error.message },
            );
            this.#opts.frames.stop();
        }
    }
}

/** A netId as the wire spells it — for tests and a `FakeServer`, which mint them. */
export function netId(n: number): NetId {
    return n as NetId;
}

/** The two envelopes that write the world. Everything else leaves a predicted pose standing. */
function isAuthoritative(envelope: ServerToClient): boolean {
    return envelope.kind === 'state' || envelope.kind === 'transform';
}

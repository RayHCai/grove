import type { ActionStates, EntityId, PointerEdge, Player } from '@platform/core';
import {
    clearRuntime,
    createActionStates,
    currentRuntime,
    displayUpdate,
    hasRuntime,
    pointerHit as dispatchPointer,
    pressWidget as dispatchPress,
} from '@platform/core';
import { defined } from '@platform/math';
import type { CameraState, IRenderer, PickOptions } from '@platform/renderer';
import { NO_NODE } from '@platform/renderer';
import type {
    GameRequest,
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    RateChange,
    Reject,
    RequestFrame,
    ServerToClient,
    StateEnvelope,
    TimeSyncReply,
    Welcome,
} from '@platform/protocol';
import type { Message, Transport } from '@platform/transport';
import { TransportError } from '@platform/transport';
import {
    ACK_STALL_TICKS,
    BUNDLE_DEADLINE_SECONDS,
    DEFAULT_VIEWPORT,
    JOIN_DEADLINE_SECONDS,
    MAX_FRAME_DT,
    MAX_REQUESTS_PER_FRAME,
    STALL_SECONDS,
    SYNC_INTERVAL_SECONDS,
} from './constants.js';
import { BindingTable } from './bindings.js';
import type { Binding, ResolvedEdge } from './bindings.js';
import { ClientClock } from './clock.js';
import { RenderBridge } from './bridge.js';
import {
    SnapshotChunks,
    asServerEnvelope,
    isUsableWelcome,
    joinRequest,
    rejectMessage,
    rttSeconds,
    send,
    timeSync,
} from './handshake.js';
import type { ClientProject, ClockSource } from './handshake.js';
import { unidentifiedProject } from './handshake.js';
import type { BundleSource } from './bundle.js';
import { BundleLoadError, loadBundle } from './bundle.js';
import type { FrameSource, InputDevice, RawInputEvent } from './input.js';
import { ClientHUDSink } from './hud-sink.js';
import { Lifecycle, isTerminal } from './lifecycle.js';
import type { FailureReason, SessionState } from './lifecycle.js';
import { Mirror, wireBounds } from './mirror.js';
import type { MirrorDelta, ScriptIndex } from './mirror.js';
import { Prediction } from './prediction.js';
import { requestFields } from './request.js';
import { InputRing } from './ring.js';

const CAMERA_ORIGIN = { x: 0, y: 0, z: 0 } as const;

/** Core's pointer handler kinds to the wire's. */
const POINTER_WIRE_KIND = {
    onClick: 'click',
    onHoverEnter: 'hover-enter',
    onHoverExit: 'hover-exit',
} as const satisfies Record<PointerEdge, Interaction['kind']>;

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
    /** Pumps a loopback pair at the top of the frame; absent for a real socket. */
    pump?: () => void;
    /** Resolves the camera each frame from the local player. Defaults to the core `Camera`. */
    camera?: (player: Player | null) => CameraState;
    /** Simulates local entities ahead of the server, replaying unacked input. Off by default. */
    predict?: boolean;
    /** The bundle's classes by wire id; what `predict` runs and what resolves an `attach`. */
    scripts?: ScriptIndex;
    /** What this build is, proved against the server's before a `Player` is allocated. */
    project?: ClientProject;
    /** Fetches and evaluates the bundle a `Welcome` names; absent, such a welcome fails. */
    bundle?: BundleSource;
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
    /** Snapshot chunks refused: over the cap, or arriving for a join already answered. */
    snapshotChunksDropped: number;
    /** Corrections too far to ease, shown at once. The nearest thing here to a desync alarm. */
    snappedCorrections: number;
}

export class GameClient {
    readonly #opts: GameClientOptions;
    readonly #lifecycle = new Lifecycle();
    readonly #bindings: BindingTable;
    readonly #ring = new InputRing();
    /** The local player's live action state — what a resync rebuilds the horizon from. */
    readonly #actions: ActionStates = createActionStates();
    /** Core's HUD seam, filled here: the HUD is one client's, so this is where it exists at all. */
    readonly #hud = new ClientHUDSink();

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

    /** The pieces of a snapshot too big for one frame, held for the `Welcome` that counts them. */
    readonly #chunks = new SnapshotChunks();

    #seq = 0;
    /** Edges resolved but not yet framed: coalesced per (action, tick) at flush. */
    readonly #pending: ResolvedEdge[] = [];
    /** HUD presses and pointer hits owed to the authority, flushed with this frame's input. */
    readonly #interactions: Interaction[] = [];
    /** `request()` calls owed to the authority, flushed with this frame's input. */
    readonly #requests: GameRequest[] = [];

    #rtt = 0;
    /** Our own send stamps, in the injected clock's ms — never the value the server echoed back. */
    #joinSentMs = 0;
    #lastSyncSentMs: number | undefined;
    /** All of these are in the FRAME source's seconds, which is the only base `#now` ever holds. */
    #now = 0;
    /** Stamped on the first frame after a join: `start()` runs before the source has a time. */
    #joinSentAt: number | undefined;
    /** The previous frame's stamp, for the display delta. Undefined before the first frame. */
    #lastFrameAt: number | undefined;
    #lastEnvelopeAt: number | undefined;
    #lastSyncAt = 0;
    #ackSeqStillAt = 0;
    #ackSeq = -1;
    #assetLoadFailed = 0;
    /** Set by a resync, cleared when input resumes: only a re-join needs held state re-asserted. */
    #rejoined = false;
    #torn = false;

    /** Frame time the bundle fetch started, or undefined; while set, the inbox drain holds. */
    #loadingSince: number | undefined;
    /** The bundle already evaluated here; survives a resync and is what the next join reports. */
    #bundleHash: string;
    /**
     * The classes the evaluated bundle carried, which outrank the ones a host supplied.
     *
     * Survives a resync beside the hash, for the same reason: the code is in this process, and a
     * re-join that declared the hash without holding the classes would resolve every `attach` to
     * nothing — a world that joins and then renders empty.
     */
    #loaded: ScriptIndex | undefined;

    /** Scratch for the tick indices one frame advanced. */
    readonly #ticks: number[] = [];
    readonly #edges: ResolvedEdge[] = [];

    constructor(opts: GameClientOptions) {
        this.#opts = opts;
        this.#bindings = new BindingTable(opts.bindings ?? []);
        this.#bundleHash = opts.project?.bundleHash ?? '';
    }

    get state(): SessionState {
        return this.#lifecycle.state;
    }

    get lifecycle(): Lifecycle {
        return this.#lifecycle;
    }

    /** The mirrored world for a host that needs the runtime. Live, not a copy; prefer `stats()`. */
    get mirror(): Mirror | undefined {
        return this.#mirror;
    }

    get ring(): InputRing {
        return this.#ring;
    }

    get actions(): ActionStates {
        return this.#actions;
    }

    /** The local player's HUD, as the host's UI layer reads it. */
    get hud(): ClientHUDSink {
        return this.#hud;
    }

    /** A HUD widget press: local handlers always run; the wire half is gated like input. */
    pressWidget(widget: string, screen?: string): void {
        const rt = this.#mirror?.runtime;
        if (rt !== undefined) {
            const player = this.localPlayer;
            void dispatchPress(rt, {
                widget,
                ...defined({ screen }),
                ...(player === null ? {} : { player }),
            });
        }
        if (!this.#lifecycle.acceptsInput) return;
        this.#interactions.push({
            kind: 'press',
            widget,
            ...defined({ screen }),
        });
    }

    /** A pointer hit by LOCAL handle; the netId mapping happens here and nowhere above. */
    pointer(edge: PointerEdge, local: EntityId): void {
        const rt = this.#mirror?.runtime;
        if (rt !== undefined) {
            const player = this.localPlayer;
            void dispatchPointer(rt, edge, local, player === null ? undefined : player);
        }
        if (!this.#lifecycle.acceptsInput) return;
        const net = this.#mirror?.index.net(local);
        if (net === undefined) return;
        this.#interactions.push({ kind: POINTER_WIRE_KIND[edge], netId: net });
    }

    /** The entity drawn under `screenPoint`; picks against what is DRAWN, not what is simulated. */
    entityAt(screenPoint: { x: number; y: number }, opts?: PickOptions): EntityId | undefined {
        const bridge = this.#bridge;
        if (bridge === undefined) return undefined;
        let node = this.#opts.renderer.nodeAt(screenPoint, opts);
        while (node !== NO_NODE) {
            const local = bridge.entityFor(node);
            if (local !== undefined) return local;
            node = this.#opts.renderer.parentOf(node);
        }
        return undefined;
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
            snapshotChunksDropped: this.#chunks.dropped,
            snappedCorrections: predicted?.counters.snappedCorrections ?? 0,
        };
    }

    /** Handlers register before the send, so ordering never depends on transport's retention. */
    start(): void {
        const { transport, device, frames } = this.#opts;

        this.#disposers.push(transport.onMessage((message) => this.#receive(message)));
        this.#disposers.push(
            transport.onClose(() => {
                // A `Reject` rides in ahead of the close it caused; this loop is what drains it.
                const refusal = this.#inbox.find((envelope) => envelope.kind === 'reject');
                if (refusal !== undefined) {
                    this.#onReject(refusal);
                    return;
                }
                this.#lifecycle.to('disconnected');
                // A fetch in flight belongs to a session that no longer exists.
                this.#loadingSince = undefined;
                frames.stop();
            }),
        );
        this.#disposers.push(device.onRaw((event) => this.#onRaw(event)));

        this.#guard(() => send(transport, this.#joinFrame()));

        frames.start((now) => this.frame(now));
    }

    /** The injected wall clock in ms — the base every wire stamp is in, and never `#now`'s. */
    #nowMs(): number {
        return this.#opts.clock.nowSeconds() * 1000;
    }

    /** The join request, stamped now and carrying the bundle this client holds. */
    #joinFrame(): ReturnType<typeof joinRequest> {
        this.#joinSentMs = this.#nowMs();
        // Cleared rather than stamped, because the deadline runs in the frame source's seconds and
        // `start()` is called before that source has produced one.
        this.#joinSentAt = undefined;
        const declared = this.#opts.project ?? unidentifiedProject();
        return joinRequest(
            this.#opts.name,
            this.#joinSentMs,
            { ...declared, bundleHash: this.#bundleHash },
            this.#opts.token,
        );
    }

    /** One display frame: drain inbound, step the clock, enqueue outbound, push to the renderer. */
    frame(nowSeconds: number): void {
        if (this.#torn) return;
        this.#now = nowSeconds;

        this.#opts.pump?.();

        // Order-sensitive: one `deliver()` hands over several envelopes, consumed in order.
        this.#drainInbox();

        // 0..N ticks. The push is below, not inside: display work runs once per frame.
        if (this.#lifecycle.state !== 'failed' && this.#clock !== undefined) {
            this.#flushInput(this.#clock.advance(nowSeconds, this.#ticks).at(-1));
            this.#flushInteractions();
            this.#flushRequests();
        }

        // After the flush, so the tick just stamped can be replayed on the frame it was sent.
        this.#predict();

        this.#checkJoinDeadline();
        this.#checkBundleDeadline();
        this.#checkNotBehind();
        this.#checkLiveness();
        this.#maybeSync();

        // Client-located `@onUpdate`, once, at display rate — after prediction, before the push.
        this.#displayUpdate(nowSeconds);

        if (this.#bridge !== undefined) {
            this.#bridge.pushTransforms(nowSeconds);
            this.#bridge.pushCamera(this.#cameraState());
        }
        this.#opts.renderer.render();
    }

    /** Runs every `ClientScript`'s `@onUpdate`; `dt` is the clamped real frame delta. */
    #displayUpdate(nowSeconds: number): void {
        const rt = this.#mirror?.runtime;
        const previous = this.#lastFrameAt;
        this.#lastFrameAt = nowSeconds;
        if (rt === undefined || this.#lifecycle.state === 'failed') return;
        const dt =
            previous === undefined ? 0 : Math.min(Math.max(nowSeconds - previous, 0), MAX_FRAME_DT);
        displayUpdate(rt, dt);
    }

    /** Carries the predicted world up to the local tick, only while `live`. */
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
        // A terminal session never drains again; an envelope kept here is held for the tab's life.
        if (isTerminal(this.#lifecycle.state)) return;
        const envelope = asServerEnvelope(message);
        // A frame that is not an envelope is a mismatched or hostile peer: dropped, not fatal.
        if (envelope === undefined) return;
        this.#inbox.push(envelope);
    }

    #drainInbox(): void {
        // Held, never dropped: the server broadcasts from the moment it sends the `Welcome`, and
        // those envelopes describe the world the pending snapshot is about to open.
        if (this.#loadingSince !== undefined) return;
        if (this.#inbox.length === 0) return;
        const batch = this.#inbox.splice(0);
        this.#lastEnvelopeAt = this.#now;

        // Once, ahead of the batch's first authoritative write: a delta names only what changed.
        if (this.#prediction !== undefined && batch.some(isAuthoritative)) {
            this.#prediction.rewind();
            this.#resimulate = true;
        }

        for (let at = 0; at < batch.length; at++) {
            // Applying into a half-torn session reports a second fault instead of the first.
            if (this.#lifecycle.state === 'failed') return;
            try {
                this.#dispatch(batch[at] as ServerToClient);
            } catch (error) {
                // An envelope that passed narrowing and still threw is malformed deeper than these
                // checks reach; failing here names the peer.
                this.#failPeer(error);
                return;
            }
            // A `Welcome` that opened a bundle fetch suspends the batch here rather than racing it:
            // the rest is put back at the FRONT, so arrival order survives the wait.
            if (this.#loadingSince !== undefined) {
                this.#inbox.unshift(...batch.slice(at + 1));
                return;
            }
        }
    }

    #dispatch(envelope: ServerToClient): void {
        switch (envelope.kind) {
            case 'welcome':
                this.#onWelcome(envelope);
                return;
            case 'snapshot-chunk':
                this.#chunks.offer(envelope, this.#welcome !== undefined);
                return;
            case 'reject':
                this.#onReject(envelope);
                return;
            case 'state':
                this.#onState(envelope);
                return;
            case 'transform':
                this.#mirror?.applyTransforms(envelope);
                return;
            case 'manifest':
                // Additive, and started rather than awaited for the reason the welcome's is: the
                // template half of the merge runs before the first `await`, so the spawn arriving
                // behind this envelope already resolves its visual.
                this.#bridge?.loadManifest(envelope.visuals).catch(() => {
                    this.#assetLoadFailed++;
                });
                return;
            case 'time-sync-reply':
                this.#onTimeSyncReply(envelope);
                return;
            case 'rate-change':
                this.#onRateChange(envelope);
                return;
            default: {
                // A ninth envelope kind must not compile to a silent no-op here: this is the sole
                // router for inbound traffic, and one presents as a server that stopped working.
                const unreachable: never = envelope;
                return unreachable;
            }
        }
    }

    /** Ends the session with the refusal phrased for a person, from the drain or the close. */
    #onReject(reject: Reject): void {
        this.#fail({
            kind: 'rejected',
            reason: rejectMessage(reject),
            serverProtocolVersion: reject.serverProtocolVersion,
        });
    }

    /** Accepts a `Welcome`; the RTT is measured HERE, before any load, since it seeds the lead. */
    #onWelcome(welcome: Welcome): void {
        // No envelope is accepted before the Welcome; a second goes through `#resync`.
        if (this.#welcome !== undefined || this.#loadingSince !== undefined) return;
        // Folded in before anything reads the snapshot, so chunking is invisible past this line.
        if (!this.#chunks.foldInto(welcome)) {
            this.#fail({
                kind: 'peer',
                message: 'the snapshot chunks did not add up to the set the Welcome named',
            });
            return;
        }
        if (!isUsableWelcome(welcome)) {
            // A `Welcome` the client cannot use is terminal, and distinct from a `Reject`.
            this.#fail({ kind: 'undecodable' });
            return;
        }

        // Measured against the stamp we recorded at send, on the clock that produced it: the echoed
        // `clientSentMs` is peer-controlled, and reading it would let a server dictate our lead.
        this.#rtt = rttSeconds(this.#nowMs(), this.#joinSentMs);

        // Nothing to fetch, or this process already holds exactly these bytes: the session opens on
        // this frame, and the pre-live state is never entered.
        if (welcome.bundleUrl === '' || welcome.bundleHash === this.#bundleHash) {
            this.#openSession(welcome);
            return;
        }

        const source = this.#opts.bundle;
        if (source === undefined) {
            // Going live without the code is the divergence the hash exists to catch.
            this.#fail({
                kind: 'bundle',
                message: 'the server sent game code this client has no way to load',
            });
            return;
        }

        this.#loadingSince = this.#now;
        this.#lifecycle.to('loading');
        void this.#load(source, welcome);
    }

    /** Fetches, verifies and evaluates the bundle, then opens the session — or fails terminally. */
    async #load(source: BundleSource, welcome: Welcome): Promise<void> {
        let loaded: ScriptIndex;
        try {
            loaded = await loadBundle(source, welcome.bundleUrl, welcome.bundleHash);
        } catch (error) {
            if (!this.#stillLoading()) return;
            this.#loadingSince = undefined;
            this.#fail({
                kind: 'bundle',
                message:
                    error instanceof BundleLoadError || error instanceof Error
                        ? error.message
                        : String(error),
            });
            return;
        }
        if (!this.#stillLoading()) return;
        this.#bundleHash = welcome.bundleHash;
        this.#loaded = loaded;
        this.#loadingSince = undefined;
        try {
            this.#openSession(welcome);
        } catch (error) {
            // A snapshot that throws while applied names the peer, and would leave `loading` set.
            this.#failPeer(error);
        }
    }

    /** Whether the welcome a fetch started for is still the one being answered. */
    #stillLoading(): boolean {
        return (
            !this.#torn && this.#loadingSince !== undefined && this.#lifecycle.state === 'loading'
        );
    }

    /** Builds the mirror, bridge and clock, applies the snapshot, and goes `live`. */
    #openSession(welcome: Welcome): void {
        this.#welcome = welcome;

        this.#mirror = new Mirror({
            simRate: welcome.simRate,
            bounds: wireBounds(welcome.bounds),
            regions: welcome.regions.map((r) => ({ name: r.name, bounds: wireBounds(r.bounds) })),
            // The evaluated bundle first: a host that also supplied classes compiled them itself,
            // and where the two disagree the ones the server named the hash of are the ones every
            // other peer is running.
            ...defined({ scripts: this.#loaded ?? this.#opts.scripts }),
        });
        // `sendRate` is the interval the render path buffers over; without it an unpredicted
        // entity holds its pose until the next envelope.
        this.#bridge = new RenderBridge(this.#opts.renderer, this.#mirror.view(), welcome.sendRate);
        // Started, not awaited: the template table fills synchronously. A rejection means missing
        // art, which the renderer draws as a placeholder, so it is counted rather than unhandled.
        this.#bridge.loadManifest(welcome.visuals).catch(() => {
            this.#assetLoadFailed++;
        });

        // The snapshot's tick seeds the counter and the RTT seeds the lead; riding `snapshot.tick`
        // keeps the seeded tick and the world it describes from disagreeing.
        this.#clock = new ClientClock({
            simRate: welcome.simRate,
            snapshotTick: welcome.snapshot.tick,
            rttSeconds: this.#rtt,
        });

        // Before the snapshot: a script attached during it may write a widget on its way up, and a
        // runtime still holding core's null sink would drop that write silently.
        this.#mirror.runtime.hudSink = this.#hud;
        // The authority is the far end of this socket, so a `request()` must cross it. Without this
        // core falls back to its loopback sink and validates an untrusted ask on the machine that
        // made it — against a mirror that holds no server-located script to validate it with.
        this.#mirror.runtime.requestUplink = (name, payload) => {
            this.#queueRequest(name, payload);
        };

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
            // Handed over live: the scope refills in place, and the buffer must leave these alone.
            this.#bridge.setPredicted(this.#prediction.scope);
            // The snapshot is authoritative state, so this frame has a baseline to replay over.
            this.#resimulate = true;
        }

        this.#lastSyncAt = this.#now;
        // Both liveness clocks start at the welcome: a slow join is not charged to the first ack.
        this.#ackSeqStillAt = this.#now;
        this.#lifecycle.to('live');
        this.#resumeInput();
    }

    #onState(envelope: StateEnvelope): void {
        const mirror = this.#mirror;
        const clock = this.#clock;
        if (mirror === undefined || clock === undefined) return;

        this.#apply(mirror.applyState(envelope));

        // The ack: prune the ring, then steer the lead off the earliest frame it resolved.
        if (envelope.ackSeq > this.#ackSeq) {
            this.#ackSeq = envelope.ackSeq;
            this.#ackSeqStillAt = this.#now;
            const earliest = this.#ring.ack(envelope.ackSeq);
            const headroom = envelope.earliestHeadroom;
            // Recovery is defined on the ring, not on arrival: an ack after a stall describes an
            // earlier frame and reads deeply negative.
            if (
                earliest !== undefined &&
                headroom !== undefined &&
                earliest.epoch === clock.epoch
            ) {
                clock.sample({ headroom, leadAtSendTicks: earliest.leadAtSendTicks });
            }
        }

        // The behind-check and stall recovery run elsewhere: `#checkNotBehind`, `#checkLiveness`.
    }

    #onTimeSyncReply(reply: TimeSyncReply): void {
        // Only a reply echoing our stamp is ours; the interval is measured off our own clock.
        const sentMs = this.#lastSyncSentMs;
        if (sentMs === undefined || reply.clientSentMs !== sentMs) return;
        this.#lastSyncSentMs = undefined;
        this.#rtt = rttSeconds(this.#nowMs(), sentMs);
    }

    #onRateChange(change: RateChange): void {
        // A resync, not a live retune: core retunes neither a pending timer, the lag ring, nor an
        // already-stamped frame.
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
            // Immediately, not from the frame loop: a hidden tab stops being driven.
            this.#pending.push(...this.#edges);
            this.#flushInput(this.#clock?.localTick, { exempt: 'focus-loss' });
            return;
        }

        if (!this.#lifecycle.acceptsInput) return;
        this.#pending.push(...this.#edges);
    }

    /** Frames the pending edges and sends them, stamped with the newest tick advanced. */
    #flushInput(tick: number | undefined, release?: { exempt: 'focus-loss' }): void {
        const clock = this.#clock;
        if (clock === undefined) return;
        if (release === undefined && !this.#lifecycle.acceptsInput) {
            // Dropped, not held: they are stamped against a tick the server will refuse as too old.
            this.#pending.length = 0;
            return;
        }
        if (tick === undefined) return;

        this.#actions.advanceTick();
        if (this.#pending.length === 0) return;

        // One entry per (action, phase), coalesced — which makes the batch well-formed.
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

    /** Sends this frame's interactions, stamped with the tick they happened on. No ring. */
    #flushInteractions(): void {
        const clock = this.#clock;
        if (clock === undefined || this.#interactions.length === 0) return;
        if (!this.#lifecycle.acceptsInput) {
            this.#interactions.length = 0;
            return;
        }
        const frame: InteractionFrame = {
            kind: 'interaction',
            tick: clock.localTick,
            events: this.#interactions.splice(0),
        };
        this.#guard(() => send(this.#opts.transport, frame));
    }

    /** Queues a creator's `request()` for the uplink; gated like input, and encoded here. */
    #queueRequest(name: string, payload?: Record<string, unknown>): void {
        if (!this.#lifecycle.acceptsInput) return;
        const call: GameRequest = { name };
        if (payload !== undefined) call.data = requestFields(payload);
        this.#requests.push(call);
    }

    /** Sends this frame's requests, stamped with the tick they were made on. */
    #flushRequests(): void {
        const clock = this.#clock;
        if (clock === undefined || this.#requests.length === 0) return;
        if (!this.#lifecycle.acceptsInput) {
            this.#requests.length = 0;
            return;
        }
        // Chunked rather than sent whole: the receiver refuses an over-cap frame ENTIRE, so a burst
        // of seventeen would lose all seventeen. Carrying the excess costs it a frame, which a
        // request — unacked and unreplayed — has no ordering claim against.
        const frame: RequestFrame = {
            kind: 'request',
            tick: clock.localTick,
            requests: this.#requests.splice(0, MAX_REQUESTS_PER_FRAME),
        };
        this.#guard(() => send(this.#opts.transport, frame));
    }

    /** Input resumed, so re-assert what the wire missed: axes always, presses after re-join. */
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

    /** The counter must lead the depicted tick, or it has left the timeline. Once per frame. */
    #checkNotBehind(): void {
        const clock = this.#clock;
        const mirror = this.#mirror;
        if (clock === undefined || mirror === undefined) return;
        if (this.#lifecycle.state !== 'live' && this.#lifecycle.state !== 'stalled') return;
        if (clock.isBehind(mirror.depictedTick)) this.#resync();
    }

    /** Fails a session whose bundle never arrives; also bounds the inbox held during the fetch. */
    #checkBundleDeadline(): void {
        const since = this.#loadingSince;
        if (since === undefined || this.#now - since < BUNDLE_DEADLINE_SECONDS) return;
        this.#loadingSince = undefined;
        this.#fail({
            kind: 'bundle',
            message: `the game code did not arrive within ${BUNDLE_DEADLINE_SECONDS} seconds`,
        });
    }

    /** Fails a join the server never answers, in either state that waits for a `Welcome`. */
    #checkJoinDeadline(): void {
        const state = this.#lifecycle.state;
        if (state !== 'connecting' && state !== 'resyncing') return;
        const since = this.#joinSentAt;
        if (since === undefined) {
            this.#joinSentAt = this.#now;
            return;
        }
        if (this.#now - since < JOIN_DEADLINE_SECONDS) return;
        this.#fail({
            kind: 'peer',
            message: `the server did not answer the join within ${JOIN_DEADLINE_SECONDS} seconds`,
        });
    }

    /** The single decider for `stalled`, both directions: a drought, or a frozen `ackSeq`. */
    #checkLiveness(): void {
        const state = this.#lifecycle.state;
        const clock = this.#clock;
        if (clock === undefined) return;
        if (state !== 'live' && state !== 'stalled') return;

        const since = this.#lastEnvelopeAt;
        const drought = since !== undefined && this.#now - since >= STALL_SECONDS;

        // In session ticks, not frames: frames fire 7× early on 144 Hz over a 20 Hz sim.
        const ackFrozen =
            this.#ring.size > 0 &&
            this.#now - this.#ackSeqStillAt >= ACK_STALL_TICKS / clock.simRate;

        if (drought || ackFrozen) this.#stall();
        else if (state === 'stalled') {
            this.#lifecycle.to('live');
            this.#resumeInput();
        }
    }

    #stall(): void {
        if (this.#lifecycle.state === 'stalled') return;
        this.#lifecycle.to('stalled');
        // This stall's samples describe starved batches, discarded by epoch, not arrival time.
        this.#clock?.bumpEpoch();
    }

    #maybeSync(): void {
        if (this.#lifecycle.state !== 'live') return;
        if (this.#now - this.#lastSyncAt < SYNC_INTERVAL_SECONDS) return;
        this.#lastSyncAt = this.#now;
        const sentMs = this.#nowMs();
        this.#lastSyncSentMs = sentMs;
        this.#guard(() => send(this.#opts.transport, timeSync(sentMs)));
    }

    /** Re-runs the join and applies a fresh snapshot; a suspension leaves the mirror stale too. */
    #resync(): void {
        this.#lifecycle.to('resyncing');
        this.#clock?.bumpEpoch();

        const delta = this.#mirror?.reset();
        if (delta !== undefined) this.#apply(delta);
        // The replacement bridge must start from an empty namespace, hierarchy included.
        this.#bridge?.clear();

        // The horizon rebuilds from live action state: what is held did not change with the clock.
        this.#ring.reset(this.#actions);
        this.#pending.length = 0;
        // The HUD belongs to the world being discarded, and the interactions name netIds the next
        // session will not hold.
        this.#hud.clear();
        this.#interactions.length = 0;
        // Stamped against a tick the next session is not seeded from, so it would arrive stale.
        this.#requests.length = 0;
        this.#ackSeq = -1;
        this.#ackSeqStillAt = this.#now;
        this.#lastEnvelopeAt = this.#now;
        this.#lastSyncSentMs = undefined;
        this.#welcome = undefined;
        // The next join answers with its own set; a chunk held from this one describes a world at a
        // tick the new session will not be seeded from.
        this.#chunks.clear();
        this.#mirror = undefined;
        this.#bridge = undefined;
        this.#clock = undefined;
        // Dropped with its runtime: a baseline holds handles that mean nothing in the next.
        this.#prediction = undefined;
        this.#resimulate = false;
        // The new session will hold nothing, so what is physically held has to be said again.
        this.#rejoined = true;
        // Any bundle fetch belongs to a welcome that will never open its session now. The loaded
        // hash is deliberately kept: the code is in this process, and the new join declares it.
        this.#loadingSince = undefined;

        this.#guard(() => send(this.#opts.transport, this.#joinFrame()));
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
            // The drawn position, not the simulated one: a camera locked to the exact answer slides
            // its target across the screen.
            const drawn = bridge.drawnPosition(local);
            return { position: { x: drawn.x, y: drawn.y, z: 0 }, zoom: camera.zoom };
        }
        return { position: camera.position, zoom: camera.zoom };
    }

    /** Reverse of setup, and idempotent — a `failed` teardown and an unmount race. */
    destroy(opts: { ownsRenderer?: boolean } = {}): void {
        if (this.#torn) return;
        this.#torn = true;

        const runtime = this.#mirror?.runtime;

        this.#shutdown();
        this.#opts.device.dispose();
        this.#bridge?.clear();
        if (opts.ownsRenderer === true) this.#opts.renderer.destroy();
        this.#mirror = undefined;
        this.#bridge = undefined;
        this.#prediction = undefined;

        // Only if the slot still holds ours: core keeps one module-global, and a second client
        // would otherwise lose its own to our teardown.
        if (runtime !== undefined && hasRuntime() && currentRuntime() === runtime) clearRuntime();
    }

    /** Maps a `TransportError` to a failure state: `encode-rejected` is ours, else the peer's. */
    #guard(fn: () => void): void {
        try {
            fn();
        } catch (error) {
            if (!(error instanceof TransportError)) throw error;
            this.#fail(
                error.code === 'encode-rejected'
                    ? { kind: 'internal', message: error.message }
                    : { kind: 'peer', message: error.message },
            );
        }
    }

    /** The one way a session ends terminally: record the reason, then shut everything down. */
    #fail(reason: FailureReason): void {
        this.#lifecycle.fail(reason);
        this.#shutdown();
    }

    /** A frame malformed deeper than the boundary narrowing reaches names the peer, never us. */
    #failPeer(error: unknown): void {
        this.#fail({
            kind: 'peer',
            message: error instanceof Error ? error.message : String(error),
        });
    }

    /** Stops the loop and closes the transport, so a dead session cannot decode into its inbox. */
    #shutdown(): void {
        this.#opts.frames.stop();
        this.#inbox.length = 0;
        for (const dispose of this.#disposers.splice(0)) dispose();
        this.#opts.transport.close();
    }
}

/** The two envelopes that write the world. Everything else leaves a predicted pose standing. */
function isAuthoritative(envelope: ServerToClient): boolean {
    return envelope.kind === 'state' || envelope.kind === 'transform';
}

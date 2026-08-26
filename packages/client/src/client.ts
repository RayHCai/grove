// GameClient: the frame order, and the one place every seam meets.
//
// The loop body is `frame(nowSeconds)` and what calls it is injected, so a Node test drives whole seconds
// with no rAF, no canvas and no socket. A React app composes rather than competes: a hook that owns the
// renderer's lifecycle calls `client.frame(now)` from its own rAF loop, so the hook is the `FrameSource`.

import type { ActionStates, EntityId, PointerEdge, Player } from '@platform/core';
import {
    clearRuntime,
    createActionStates,
    currentRuntime,
    hasRuntime,
    pointerHit as dispatchPointer,
    pressWidget as dispatchPress,
} from '@platform/core';
import type { CameraState, IRenderer } from '@platform/renderer';
import type {
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    NetId,
    RateChange,
    ServerToClient,
    SnapshotChunk,
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
    MAX_SNAPSHOT_CHUNKS,
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
import type { ClientProject, ClockSource } from './handshake.js';
import { unidentifiedProject } from './handshake.js';
import type { BundleSource } from './bundle.js';
import { BundleError, loadBundle } from './bundle.js';
import type { FrameSource, InputDevice, RawInputEvent } from './input.js';
import { ClientHUDSink } from './hud-sink.js';
import { Lifecycle } from './lifecycle.js';
import type { SessionState } from './lifecycle.js';
import { Mirror, wireBounds } from './mirror.js';
import type { MirrorDelta, TemplateScripts } from './mirror.js';
import { Prediction } from './prediction.js';
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
    /**
     * What this build is, proved against the server's before a `Player` is allocated. Omitted, this
     * client declares no project — which only an equally undeclared server admits.
     */
    project?: ClientProject;
    /**
     * Fetches and evaluates the script bundle a `Welcome` names. Needed only when the server names
     * one; absent, a welcome carrying a `bundleUrl` fails the session rather than skipping the load.
     */
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

    /**
     * Snapshot chunks held for the `Welcome` that names how many there are.
     *
     * Held rather than applied: a chunk carries no tick and describes a world the client has not been
     * told it is joining, so a set with no `Welcome` behind it is never written anywhere.
     */
    readonly #chunks: SnapshotChunk[] = [];
    /** Chunks refused as unusable — over the cap, or arriving for a join already answered. */
    #chunksDropped = 0;

    #seq = 0;
    /** Edges resolved but not yet framed: coalesced per (action, tick) at flush. */
    readonly #pending: ResolvedEdge[] = [];
    /** HUD presses and pointer hits owed to the authority, flushed with this frame's input. */
    readonly #interactions: Interaction[] = [];

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

    /**
     * The frame time the bundle fetch started, or undefined when nothing is being awaited.
     *
     * While it is set the inbox drain holds everything: a welcome that has not opened its session
     * yet has no mirror, clock or bridge for a later envelope to land in.
     */
    #loadingSince: number | undefined;
    /**
     * The bundle already fetched, verified and evaluated in this process.
     *
     * Survives a resync deliberately — the code is loaded, and re-fetching it on every reconnect
     * would re-evaluate a module the page still holds. It is also what the next `JoinRequest`
     * reports, so a server that has since moved on refuses rather than letting the two diverge.
     */
    #bundleHash: string;

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

    /** The local player's HUD, as the host's UI layer reads it. */
    get hud(): ClientHUDSink {
        return this.#hud;
    }

    /**
     * A HUD widget press: the local handlers run now, and the authority is told.
     *
     * The local half is unconditional — hover, press animation, selection and disabled styling are
     * client state and must not go dead because the session stalled — while the wire half is gated
     * like input, since a press the server would refuse as stale is worse than one never sent.
     * `screen` names the screen the widget belongs to, which is what scopes a `ClientScript<HUDScreen>`
     * handler to its own buttons.
     */
    pressWidget(widget: string, screen?: string): void {
        const rt = this.#mirror?.runtime;
        if (rt !== undefined) {
            const player = this.localPlayer;
            void dispatchPress(rt, {
                widget,
                ...(screen === undefined ? {} : { screen }),
                ...(player === null ? {} : { player }),
            });
        }
        if (!this.#lifecycle.acceptsInput) return;
        this.#interactions.push({
            kind: 'press',
            widget,
            ...(screen === undefined ? {} : { screen }),
        });
    }

    /**
     * A pointer hit on a mirrored entity, addressed by the LOCAL handle the render layer holds.
     *
     * The netId mapping happens here and nowhere above, so the layer that hit-tests never learns
     * there is a network; an entity with no mapping is local-only and reaches no authority.
     */
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
            snapshotChunksDropped: this.#chunksDropped,
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

        this.#guard(() => send(transport, this.#joinFrame()));

        frames.start((now) => this.frame(now));
    }

    /**
     * The join request, stamped now and carrying the bundle this client currently holds.
     *
     * Built here rather than at each call site so the resync sends the same claim the first join
     * did — with one difference that matters: a bundle loaded since then rides it, and a server that
     * has moved on refuses rather than letting the two run different code.
     */
    #joinFrame(): ReturnType<typeof joinRequest> {
        this.#joinSentMs = this.#opts.clock.nowSeconds() * 1000;
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

        // Order-sensitive: one `deliver()` routinely hands over several envelopes, and the bridge consumes
        // their deltas in the same order rather than merging them.
        this.#drainInbox();

        // 0..N ticks. The push is below rather than inside this, because it is display work at display
        // rate: a frame that advanced three ticks still pushes once.
        if (this.#lifecycle.state !== 'failed' && this.#clock !== undefined) {
            this.#clock.advance(nowSeconds, this.#ticks);
            this.#flushInput(this.#ticks);
            this.#flushInteractions();
        }

        // After the flush, so the tick just stamped can be replayed on the frame it was sent.
        this.#predict();

        this.#checkBundleDeadline();
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
        // Held, never dropped: the server broadcasts from the moment it sends the `Welcome`, and
        // those envelopes describe the world the pending snapshot is about to open.
        if (this.#loadingSince !== undefined) return;
        if (this.#inbox.length === 0) return;
        const batch = this.#inbox.splice(0);
        this.#lastEnvelopeAt = this.#now;

        // Once, ahead of the batch's first authoritative write rather than inside it: a delta names only
        // what changed, so a field it does not mention would keep its predicted value and never converge.
        if (this.#prediction !== undefined && batch.some(isAuthoritative)) {
            this.#prediction.rewind();
            this.#resimulate = true;
        }

        for (let at = 0; at < batch.length; at++) {
            // Nothing after a terminal failure can matter, and applying into a half-torn session is how a
            // second fault gets reported instead of the first.
            if (this.#lifecycle.state === 'failed') return;
            try {
                this.#dispatch(batch[at] as ServerToClient);
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
                this.#onSnapshotChunk(envelope);
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
        }
    }

    /**
     * Accepts a `Welcome` and decides whether a session can open now or has to wait for code.
     *
     * The RTT is measured HERE rather than after any load: it seeds the lead, and a fetch folded into
     * it would size the lead to the download instead of to the round trip.
     */
    #onWelcome(welcome: Welcome): void {
        // No envelope is accepted before the Welcome, and a second one is ignored: the mirror it would
        // rebuild is the resync path's, which goes through `#resync`.
        if (this.#welcome !== undefined || this.#loadingSince !== undefined) return;
        // Folded in before anything reads the snapshot, so every path below sees one whole world and
        // chunking stays invisible past this line.
        if (!this.#foldChunks(welcome)) {
            this.#lifecycle.fail({
                kind: 'peer',
                message: 'the snapshot chunks did not add up to the set the Welcome named',
            });
            this.#opts.frames.stop();
            return;
        }
        if (!isUsableWelcome(welcome)) {
            // A `Welcome` the client cannot use means the server does not speak this client's JSON —
            // terminal, and distinct from a `Reject`, which carries a reason.
            this.#lifecycle.fail({ kind: 'undecodable' });
            this.#opts.frames.stop();
            return;
        }

        // Measured against the stamp we recorded at send, on the clock that produced it: the echoed
        // `clientSentMs` is peer-controlled, and reading it would let a server dictate our lead.
        this.#rtt = rttSeconds(this.#opts.clock.nowSeconds() * 1000, this.#joinSentMs);

        // Nothing to fetch, or this process already holds exactly these bytes: the session opens on
        // this frame, and the pre-live state is never entered.
        if (welcome.bundleUrl === '' || welcome.bundleHash === this.#bundleHash) {
            this.#openSession(welcome);
            return;
        }

        const source = this.#opts.bundle;
        if (source === undefined) {
            // Never silently skipped: a client with no loader cannot run what the server is running,
            // and going live anyway is the divergence the hash exists to catch.
            this.#lifecycle.fail({
                kind: 'bundle',
                message: 'the server sent game code this client has no way to load',
            });
            this.#opts.frames.stop();
            return;
        }

        this.#loadingSince = this.#now;
        this.#lifecycle.to('loading');
        void this.#load(source, welcome);
    }

    /**
     * Fetches, verifies and evaluates the bundle, then opens the session — or fails, terminally.
     *
     * A mismatch is not a retry: the bytes that arrived are not the bytes the authority simulates
     * with, and running them anyway is exactly the silent divergence this whole path exists to stop.
     */
    async #load(source: BundleSource, welcome: Welcome): Promise<void> {
        try {
            await loadBundle(source, welcome.bundleUrl, welcome.bundleHash);
        } catch (error) {
            if (this.#torn) return;
            this.#loadingSince = undefined;
            this.#lifecycle.fail({
                kind: 'bundle',
                message:
                    error instanceof BundleError || error instanceof Error
                        ? error.message
                        : String(error),
            });
            this.#opts.frames.stop();
            return;
        }
        // The session may have been torn down or resynced while the fetch was in flight; either way
        // this welcome is no longer the one being answered.
        if (this.#torn || this.#loadingSince === undefined) return;
        this.#bundleHash = welcome.bundleHash;
        this.#loadingSince = undefined;
        this.#openSession(welcome);
    }

    /** Builds the mirror, bridge and clock, applies the snapshot, and goes `live`. */
    #openSession(welcome: Welcome): void {
        this.#welcome = welcome;

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

        // Before the snapshot: a script attached during it may write a widget on its way up, and a
        // runtime still holding core's null sink would drop that write silently.
        this.#mirror.runtime.hudSink = this.#hud;

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

    /**
     * Buffers one chunk of a snapshot too big for a single frame.
     *
     * Bounded on arrival rather than at the fold: the count the `Welcome` will name has not been seen
     * yet, so this is the only place that can refuse to keep growing. A chunk for a join already
     * answered is dropped — a live session's world comes from deltas, never from a chunk.
     */
    #onSnapshotChunk(chunk: SnapshotChunk): void {
        if (this.#welcome !== undefined || this.#chunks.length >= MAX_SNAPSHOT_CHUNKS) {
            this.#chunksDropped++;
            return;
        }
        this.#chunks.push(chunk);
    }

    /**
     * Prepends every held chunk to the welcome's own snapshot, in index order.
     *
     * False when the set does not match what the `Welcome` named — a short set would open a session
     * on a world missing entities the server believes it sent, which reads later as a mirror bug
     * rather than as the truncated join it is.
     */
    #foldChunks(welcome: Welcome): boolean {
        const expected = welcome.snapshotChunks ?? 0;
        if (this.#chunks.length !== expected) return false;
        const held = this.#chunks.splice(0);
        if (expected === 0) return true;

        // The wire is FIFO, so arrival order is already emission order; sorting states the invariant
        // the fold depends on rather than trusting it, and a duplicate index shows up as a gap.
        held.sort((a, b) => a.index - b.index);
        if (held.some((chunk, at) => chunk.index !== at)) return false;

        const snapshot = welcome.snapshot;
        // Ahead of the welcome's own, because `entities` is parents-before-children across the whole
        // set and the chunks carry the earlier half of that order.
        snapshot.entities = [...held.flatMap((c) => c.entities), ...snapshot.entities];
        snapshot.state = [...held.flatMap((c) => c.state), ...snapshot.state];
        return true;
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
     * Sends this frame's interactions, stamped with the tick they happened on.
     *
     * No `seq` and no ring: an interaction is one discrete event, so there is nothing to re-derive
     * from a later sample and nothing to replay — which is also why it is not folded into the input
     * frame, where every field exists to make edges replayable.
     */
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
     * Fails a session whose bundle never arrives.
     *
     * It bounds the held inbox as much as the wait: the server broadcasts from the moment it sent the
     * `Welcome`, and a fetch that hangs would otherwise queue envelopes for as long as the tab lives.
     * `stalled` cannot cover this — that is a decision about a live session's connection, and there is
     * no session yet.
     */
    #checkBundleDeadline(): void {
        const since = this.#loadingSince;
        if (since === undefined || this.#now - since < BUNDLE_DEADLINE_SECONDS) return;
        this.#loadingSince = undefined;
        this.#lifecycle.fail({
            kind: 'bundle',
            message: `the game code did not arrive within ${BUNDLE_DEADLINE_SECONDS} seconds`,
        });
        this.#opts.frames.stop();
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
        // The HUD belongs to the world being discarded, and the interactions name netIds the next
        // session will not hold.
        this.#hud.clear();
        this.#interactions.length = 0;
        this.#ackSeq = -1;
        this.#ackSeqStillAt = this.#now;
        this.#lastEnvelopeAt = this.#now;
        this.#lastSyncSentMs = undefined;
        this.#welcome = undefined;
        // The next join answers with its own set; a chunk held from this one describes a world at a
        // tick the new session will not be seeded from.
        this.#chunks.length = 0;
        this.#mirror = undefined;
        this.#bridge = undefined;
        this.#clock = undefined;
        // Dropped with the runtime it belongs to: a baseline holds handles that mean nothing in the next.
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

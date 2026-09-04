import type { Bounds } from '@platform/math';
import { defined } from '@platform/math';
import type {
    BreakerTrip,
    EngineConfig,
    GameManifest,
    KVStore,
    LogSink,
    Player,
    Runtime,
} from '@platform/core';
import {
    Asset,
    AssetRegistry,
    Loop,
    joinPlayer,
    leavePlayer,
    loadGame,
    playerKey,
    resolveConfig,
    startGame,
} from '@platform/core';
import type { ScriptId } from '@platform/project';
import type {
    ClientToServer,
    GameRequest,
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    JoinRequest,
    ProjectId,
    RejectReason,
    RenderManifest,
    RequestFrame,
    ServerToClient,
    TimeSync,
    Welcome,
    WireBounds,
    WireRegion,
    WireStructuralOp,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { Codec, JsonValue, Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import type {
    CloseOrder,
    ConnectionId,
    InputBatch,
    LoadOrder,
    LogLine,
    OutputBatch,
    SaveOrder,
    Send,
} from './batch.js';
import { Session } from './session.js';
import type { RosterOps } from './replicate.js';
import { drainOnce, readPlayerSnapshot, stateEnvelopeFor, transformEnvelope } from './replicate.js';
import { splitSnapshot } from './chunk.js';
import {
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_IDENTITY_LENGTH,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_NAME_LENGTH,
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_NAME_LENGTH,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_STRUCTURAL_OPS_PER_SEND,
    MAX_UNJOINED_CONNECTIONS,
    MAX_WIDGET_NAME_LENGTH,
    assertRate,
    joinDeadlineTicks,
    pastGraceTicks,
} from './constants.js';
import { SimError } from './errors.js';
import { InputBuffer, runInputPass } from './input.js';
import { ManifestStore } from './manifest.js';
import { SessionRecords } from './persisted.js';
import { buildSnapshot } from './snapshot.js';

/** What this world is running, proved against every joiner's claim before a `Player` is allocated. */
export interface ProjectIdentity {
    projectId: ProjectId;
    projectHash: string;
    /** Lowercase-hex SHA-256 of the bytes at `bundleUrl`; `''` when this build serves no bundle. */
    bundleHash: string;
    /** Fetched by the browser over HTTP, never sent down the game socket. `''` for no bundle. */
    bundleUrl: string;
}

/** A world that declares no project — every field empty, which is what a client declaring none sends, so agreement rather than absence is what passes. */
const UNIDENTIFIED: ProjectIdentity = {
    projectId: '',
    projectHash: '',
    bundleHash: '',
    bundleUrl: '',
};

/** The class → id edge core needs, declared structurally rather than imported because `@platform/scripting` imports core. */
export interface ScriptIndex {
    idOf(klass: abstract new (...args: never[]) => object): ScriptId | undefined;
}

/** The sim's own load-time input, carrying what core's manifest cannot. */
export interface SimConfig extends Partial<EngineConfig> {
    bounds?: Bounds;
    regions?: Array<{ name: string; bounds: Bounds }>;
    /** Panel-authored art, passed through to `Welcome.visuals`. */
    visuals?: RenderManifest;
    /** Game-hosted `ServerScript` classes, forwarded to `loadGame`. */
    gameScripts?: GameManifest['gameScripts'];
    /** What every spawn key means, from `toGameManifest(validate(file), …)`. */
    templates?: GameManifest['templates'];
    /** The placed world, parents before children — instantiated before the first tick. */
    entities?: GameManifest['entities'];
    /** Names a script class on the wire; without it no `attach` op is journaled at all, since the op names an id. */
    scripts?: ScriptIndex;
    /** What this build is. Omitted, every joiner declaring nothing is admitted and nothing else. */
    project?: ProjectIdentity;
    /**
     * The creator-facing storage seam a `ServerScript` awaits — NOT where `@serverState` is
     * checkpointed, which rides the batch as a load and a save.
     *
     * A handler awaits it, so it stays a promise-returning seam rather than a batch field; a host
     * with no store in this process supplies one over its own transport. Omitted, core's
     * `MemoryKVStore` stands in and dies with the world.
     */
    kv?: KVStore;
}

export interface SimOptions {
    config?: SimConfig;
    /**
     * The codec a `Welcome` is MEASURED against when deciding whether to chunk it.
     *
     * The sim encodes nothing for the wire — the host does — so this must be the codec the host
     * encodes with, or a snapshot sized here fits a frame the host cannot produce.
     */
    codec?: Codec;
    /**
     * An in-process sink for this world's diagnostics, beside the lines every batch carries.
     *
     * Every line reaches `OutputBatch.log` whatever this is; a host sharing the process can take
     * them here instead of unpacking them.
     */
    log?: LogSink;
    /** Called when the breaker disables a script's handler or callback — the dev channel, deliberately not an envelope. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
}

/**
 * The authority's deterministic advance: one input batch in, one output batch out.
 *
 * It holds the one core `Runtime` and everything between a DECODED inbound frame and an outbound
 * envelope — the narrowing, admission, the tick-keyed input buffer, the step, and the drain of
 * core's three replication channels. It opens no socket, reads no clock and touches no store: the
 * time it stamps and the records it seeds both arrive in the batch, which is what lets the host be
 * another process in another language and lets this same advance run in a browser.
 */
export class Sim {
    /** Live sessions, keyed by the host's connection id — the collection a transport does not hold. */
    readonly #sessions = new Map<ConnectionId, Session>();
    readonly #rt: Runtime;
    readonly #loop: Loop;
    readonly #codec: Codec;
    /** The load-time config. `simRate` is live on the runtime instead, since `setSimRate` retunes it. */
    readonly #config: EngineConfig;
    readonly #bounds: WireBounds;
    readonly #regions: WireRegion[];
    /** Live, not captured: templates come into use mid-session and connected peers are owed them. */
    readonly #visuals: ManifestStore;
    readonly #project: ProjectIdentity;
    readonly #buffer = new InputBuffer();
    /** Roster ops awaiting the next send — core's journal has no arm for either. */
    readonly #roster: RosterOps = { joins: [], leaves: [] };
    /** Structural ops over this send's budget, kept in order for the next one — the only state that survives a send set. */
    readonly #spill: WireStructuralOp[] = [];
    readonly #started: Promise<void>;
    /** `@serverState` that outlives a session, seeded by the host and captured back at a leave. */
    readonly #records = new SessionRecords();

    /** This tick's output, emptied by every {@link Sim.tick}. */
    #sends: Send[] = [];
    #closes: CloseOrder[] = [];
    #loads: LoadOrder[] = [];
    #saves: SaveOrder[] = [];
    /** Lines since the last batch took them — buffered rather than emitted, so construction's survive to the first tick. */
    #log: LogLine[] = [];

    /** Marks and ops dropped as unrepresentable, cumulative. */
    #dropped = 0;
    /** Marks whose host died before the send that would have carried them, cumulative. */
    #stale = 0;
    #closed = false;
    /** False until the world exists; a connection offered while it is is refused. */
    #booted = false;

    constructor(opts: SimOptions = {}) {
        const config = opts.config ?? {};
        this.#config = resolveConfig(config);
        // Both rates are checked before a world is built rather than after: a bad rate must refuse
        // the construction, not the first tick against a world that already exists.
        assertRate('simRate', this.#config.simRate);
        assertRate('sendRate', this.#config.sendRate);
        if (!Number.isInteger(this.#config.maxPlayers) || this.#config.maxPlayers < 1) {
            throw new SimError(
                'invalid-config',
                `maxPlayers must be a positive integer, received ${this.#config.maxPlayers}`,
            );
        }
        this.#codec = opts.codec ?? jsonCodec;

        const bounds = config.bounds ?? { left: -400, right: 400, top: 300, bottom: -300 };
        this.#bounds = toWireBounds(bounds);
        this.#regions = (config.regions ?? []).map((r) => ({
            name: r.name,
            bounds: toWireBounds(r.bounds),
        }));
        this.#visuals = new ManifestStore(config.visuals);
        this.#project = config.project ?? UNIDENTIFIED;

        // `role: 'server'` is the trust boundary: the loop dispatches only server and synced
        // handlers, so client-only scripts are inert here.
        this.#rt = loadGame(
            {
                role: 'server',
                simRate: this.#config.simRate,
                bounds,
                ...defined({
                    regions: config.regions,
                    assets: config.visuals?.assets.map((a) => assetManifestEntry(a)),
                    templates: config.templates,
                    entities: config.entities,
                    gameScripts: config.gameScripts,
                }),
            },
            {
                log: this.#sink(opts.log),
                ...(config.scripts === undefined
                    ? {}
                    : {
                          scriptIdOf: (klass: abstract new (...args: never[]) => object) =>
                              config.scripts?.idOf(klass),
                      }),
            },
        );
        this.#loop = new Loop(this.#rt);

        if (config.kv !== undefined) this.#rt.kv = config.kv;
        this.#rt.persisted = this.#records;

        // Registered before `startGame` below, so a Game `@onStart` that trips the breaker on its
        // very first tick is still reported.
        if (opts.onBreakerTrip !== undefined) this.#rt.dispatcher.onTrip(opts.onBreakerTrip);

        // Installed before the first step, so no tick ever runs against core's stub.
        const passes = this.#rt.passes;
        if (passes === undefined) {
            throw new SimError(
                'no-pass-table',
                'loadGame returned no tick passes; the input pass has nowhere to install',
            );
        }
        this.#rt.passes = {
            ...passes,
            input: (dispatch) =>
                runInputPass(
                    {
                        rt: this.#rt,
                        buffer: this.#buffer,
                        sessions: () => this.#sessions.values(),
                    },
                    dispatch,
                ),
        };

        // Not awaited: a start handler awaiting a timer cannot complete until the loop steps, so
        // awaiting this would deadlock the world against whatever drives it.
        this.#started = startGame(this.#rt);

        this.#booted = true;
    }

    /** Settles when every Game start handler has finished, for a host that wants to know. */
    get started(): Promise<void> {
        return this.#started;
    }

    get runtime(): Runtime {
        return this.#rt;
    }

    /** A copy, with the live `simRate`: the load-time value is stale the moment `setSimRate` runs. */
    get config(): EngineConfig {
        return { ...this.#config, simRate: this.#rt.simRate };
    }

    /** Marks and ops dropped as unsendable. Nonzero is a bug report, not a failure. */
    get droppedMarks(): number {
        return this.#dropped;
    }

    /**
     * Marks whose host died between the write and the send that would have carried them.
     *
     * Expected in any world that destroys anything, so it reads as churn rather than as a defect —
     * a rate worth watching, never a count worth alerting on.
     */
    get staleMarks(): number {
        return this.#stale;
    }

    /** Live sessions in open order. */
    get sessions(): Session[] {
        return [...this.#sessions.values()];
    }

    /** Whether the world is built, and so whether a connection offered to it will be taken. */
    get booted(): boolean {
        return this.#booted;
    }

    /** Whether this world has been released; every later tick is inert. */
    get closed(): boolean {
        return this.#closed;
    }

    /**
     * One fixed step: take the batch's arrivals, advance the world by exactly one tick, and report
     * everything the host must act on.
     *
     * The tick index is the sim's own and always contiguous — core's timers and tweens advance one
     * unit per `step()` whatever index they are handed, so a host that skipped indices would
     * compress every `after`, `every`, `sleep` and tween by the gap. Falling behind is therefore the
     * host's to shed in wall-clock, never in ticks.
     */
    tick(batch: InputBatch): OutputBatch {
        if (this.#closed) return this.#takeOutput();

        for (const opened of batch.opened) this.#open(opened.connectionId, opened.identity);
        for (const hostKey of batch.saved) this.#records.release(hostKey);
        for (const record of batch.records) this.#seed(record.connectionId, record.fields);
        for (const frame of batch.frames) this.#receive(frame.connectionId, frame.message);
        for (const connectionId of batch.closed) this.#drop(connectionId);

        this.#stepOnce();
        this.#sweepJoinDeadline();
        if (batch.drain) this.#drain(batch.nowMs);

        return this.#takeOutput();
    }

    /**
     * Releases the world: every session leaves inline, so the batch this returns carries the last
     * save each of them is owed.
     *
     * Inline rather than by waiting for the host to report each socket closed, because after a
     * shutdown there is no next batch to report them in. Idempotent, and every later tick is inert.
     */
    close(): OutputBatch {
        if (this.#closed) return this.#takeOutput();
        this.#closed = true;
        // Deleting the entry the iterator has already yielded is well-defined, which is what lets
        // this run inline over the live registry rather than over a copy of it.
        for (const session of this.#sessions.values()) this.#release(session);
        return this.#takeOutput();
    }

    /** Declares visuals for templates that have come into use since boot. Idempotent per name. */
    declareVisuals(manifest: RenderManifest): void {
        this.#visuals.declare(manifest);
        // `rt.assets` is the read-only `Assets` facade; only the registry `loadGame` built can take
        // a definition, and a host that swapped in its own is not ours to write to.
        const registry = this.#rt.assets;
        if (!(registry instanceof AssetRegistry)) return;
        for (const asset of manifest.assets) {
            if (registry.get(asset.key) !== null) continue;
            registry.define(
                new Asset(
                    asset.key,
                    asset.kind,
                    ...(asset.meta === undefined ? [] : ([asset.meta] as const)),
                ),
            );
        }
    }

    /** Changes the timestep mid-session and tells every client, which treats it as a resync trigger — core retunes neither a pending timer nor the lag ring. */
    setSimRate(simRate: number): void {
        assertRate('simRate', simRate);
        this.#rt.setSimRate(simRate);
        const to: ConnectionId[] = [];
        for (const session of this.#sessions.values()) {
            if (session.joined) to.push(session.connectionId);
        }
        this.#send(to, { kind: 'rate-change', tick: this.#rt.tick, simRate }, 'reliable');
    }

    /** The whole of one tick's output, and the point every accumulator is emptied at. */
    #takeOutput(): OutputBatch {
        const out: OutputBatch = {
            tick: this.#rt.tick,
            sends: this.#sends,
            closes: this.#closes,
            loads: this.#loads,
            saves: this.#saves,
            log: this.#log,
            diagnostics: { dropped: this.#dropped, stale: this.#stale },
        };
        this.#sends = [];
        this.#closes = [];
        this.#loads = [];
        this.#saves = [];
        this.#log = [];
        return out;
    }

    /** Queues one envelope for one or many peers, in the order the host must write it. */
    #send(to: ConnectionId[], envelope: ServerToClient, cls: Send['class']): void {
        if (to.length > 0) this.#sends.push({ to, envelope, class: cls });
    }

    /** Core's diagnostics and this package's denials leave through one sink, buffered until a batch takes them. */
    #sink(forward: LogSink | undefined): LogSink {
        return {
            warn: (message: string): void => {
                this.#log.push({ level: 'warn', line: message });
                forward?.warn(message);
            },
            error: (record: Parameters<LogSink['error']>[0]): void => {
                forward?.error(record);
            },
        };
    }

    /** Takes one established connection under the identity the HOST resolved, or refuses it. */
    #open(connectionId: ConnectionId, identity: string | null): void {
        const refusal = this.#openRefusal(identity);
        if (refusal !== null) {
            // No connection id in the line: an id is minted for a socket this world keeps, and one
            // in a line for a socket it just refused is an id a reader would go looking for.
            this.#rt.log.warn(`accept-refused reason=${refusal}`);
            this.#closes.push({ connectionId, reason: refusal });
            return;
        }
        this.#sessions.set(connectionId, new Session(connectionId, identity, this.#rt.tick));
    }

    /** Why this connection may not be registered, or null to take it. */
    #openRefusal(identity: string | null): string | null {
        if (!this.#booted) return 'not-booted';
        if (this.#closed) return 'sim-closed';
        let unjoined = 0;
        let claimed = false;
        for (const session of this.#sessions.values()) {
            if (session.joined) continue;
            unjoined += 1;
            if (session.identity === identity) claimed = true;
        }
        if (unjoined >= MAX_UNJOINED_CONNECTIONS) return 'unjoined-cap';
        // One pre-join slot per named peer: the cap above is a total, so without this a single peer
        // reconnect-looping holds every slot and locks out everyone else at no cost to itself.
        return identity !== null && claimed ? 'identity-pending' : null;
    }

    /** Files the host's answer to a load and resumes the join that was waiting on it. */
    #seed(connectionId: ConnectionId, fields: { [field: string]: JsonValue } | null): void {
        const session = this.#sessions.get(connectionId);
        if (session === undefined) return;
        // A failed read seeds NOTHING and is admitted anyway: the session runs on this build's
        // initializers, and the empty cache is what stops the leave writing them over the save it
        // could not read.
        if (fields !== null) this.#records.seed(playerKey(session.playerId), fields);
        session.admitting = false;
        const request = session.awaitingRecord;
        session.awaitingRecord = null;
        if (request !== null) this.#admit(session, request);
    }

    /** Narrows one inbound frame; a frame it cannot name is ignored and the session survives. */
    #receive(connectionId: ConnectionId, message: unknown): void {
        const session = this.#sessions.get(connectionId);
        if (session === undefined || session.closed) return;
        const envelope = asClientEnvelope(message);
        if (envelope === undefined) return;
        const onInputBucket =
            envelope.kind === 'input' ||
            envelope.kind === 'interaction' ||
            envelope.kind === 'request';
        if (!onInputBucket && !session.admission.takeControlToken()) return;
        if (session.joined) session.admission.noteTraffic(this.#rt.tick);
        switch (envelope.kind) {
            case 'join-request':
                this.#join(session, envelope);
                return;
            case 'input':
                this.#input(session, envelope);
                return;
            case 'interaction':
                this.#interaction(session, envelope);
                return;
            case 'request':
                this.#request(session, envelope);
                return;
            case 'time-sync':
                // Answered on the next send rather than here, so the tick it names is one the world
                // has reached rather than whatever this batch found it at.
                session.pendingTimeSync = envelope;
                return;
        }
    }

    /** The join sequence, in the order the checks must run: version, identity, then — once the persisted record is cached — capacity. */
    #join(session: Session, request: JoinRequest): void {
        if (session.joined) {
            if (request.protocolVersion !== PROTOCOL_VERSION) this.#reject(session, 'version');
            else if (!this.#identityMatches(request)) this.#reject(session, 'identity');
            else session.pendingJoin = request;
            return;
        }

        if (request.protocolVersion !== PROTOCOL_VERSION) {
            this.#reject(session, 'version');
            return;
        }
        if (!this.#identityMatches(request)) {
            this.#reject(session, 'identity');
            return;
        }
        if (session.admitting) return;

        if (session.identity !== null && !this.#records.has(playerKey(session.playerId))) {
            // Asked for once and answered in a later batch, which is what makes an identified join
            // land a turn after an anonymous one.
            session.admitting = true;
            session.awaitingRecord = request;
            this.#loads.push({
                connectionId: session.connectionId,
                hostKey: playerKey(session.playerId),
            });
            return;
        }
        this.#admit(session, request);
    }

    /** Allocates the Player, once this session's persisted record is in the cache. */
    #admit(session: Session, request: JoinRequest): void {
        if (session.closed || this.#closed || session.joined) return;

        // Tested here rather than at the request: an identified join waits on the persisted read and
        // the roster can fill while it does.
        const roster = this.#rt.playerManager?.players.length ?? 0;
        if (roster >= this.#config.maxPlayers) {
            this.#reject(session, 'full');
            return;
        }
        // Two live sessions under one id share a host record, and the second to leave would write
        // its own values over the first's.
        if ((this.#rt.playerManager?.byId(session.playerId) ?? null) !== null) {
            this.#rt.log.warn(`refusing a second connection claiming ${session.playerId}`);
            this.#reject(session, 'full');
            return;
        }

        const player = joinPlayer(this.#rt, session.playerId, sanitizeName(request.name));
        session.player = player;
        session.admission.noteTraffic(this.#rt.tick);
        session.pendingJoin = request;

        // Queued rather than sent, so the next drain prepends it ahead of the spawns the join
        // handler just produced.
        this.#roster.joins.push(readPlayerSnapshot(player));
    }

    /** Whether a joiner is running what this world is running; a `bundleHash` of `''` is the one legal asymmetry. */
    #identityMatches(request: JoinRequest): boolean {
        if (request.projectId !== this.#project.projectId) return false;
        if (request.projectHash !== this.#project.projectHash) return false;
        return request.bundleHash === '' || request.bundleHash === this.#project.bundleHash;
    }

    #reject(session: Session, reason: RejectReason): void {
        this.#deny('reject', session, reason);
        this.#send(
            [session.connectionId],
            { kind: 'reject', reason, serverProtocolVersion: PROTOCOL_VERSION },
            'reliable',
        );
        // Behind the envelope, never instead of it: a bare close is indistinguishable from a drop,
        // and the right answers invert — a drop should retry, a version mismatch must never.
        this.#closes.push({ connectionId: session.connectionId, reason });
        this.#release(session);
    }

    /** One line per denial, in `key=value` tokens an operator greps for; any prose comes last. */
    #deny(event: string, session: Session, reason: string, detail?: string): void {
        const tail = detail === undefined ? '' : `: ${detail}`;
        this.#rt.log.warn(`${event} conn=${session.connectionId} reason=${reason}${tail}`);
    }

    #input(session: Session, frame: InputFrame): void {
        if (!session.joined) return;
        const result = this.#buffer.admit(session, frame, this.#rt.tick, this.#rt.simRate);

        if (
            result.kind === 'refused' &&
            result.reason === 'rate' &&
            session.admission.overRateBreachLimit
        ) {
            this.#closeFor(session, 'rate-breach');
        }
    }

    /** Queues a frame's interactions for the tick pass, which is where they are dispatched. */
    #interaction(session: Session, frame: InteractionFrame): void {
        if (!session.joined || !this.#takeInputToken(session)) return;
        for (const event of frame.events) session.interactions.push(event);
    }

    /** Queues a frame's requests for the tick pass, which is where the authority answers them. */
    #request(session: Session, frame: RequestFrame): void {
        if (!session.joined || !this.#takeInputToken(session)) return;
        for (const call of frame.requests) session.requests.push(call);
    }

    /** Spends an input token for a frame the bucket meters, closing a session that has sustained a breach. */
    #takeInputToken(session: Session): boolean {
        if (session.admission.takeToken()) return true;
        if (session.admission.overRateBreachLimit) this.#closeFor(session, 'rate-breach');
        return false;
    }

    /** Orders the host to close a session and releases it here, so this tick's step already skips it. */
    #closeFor(session: Session, reason: string): void {
        this.#deny('close', session, reason);
        this.#closes.push({ connectionId: session.connectionId, reason });
        this.#release(session);
    }

    /** One tick: refill every session's tokens, step the world, then date whatever gaps the window has outrun. */
    #stepOnce(): void {
        const simRate = this.#rt.simRate;
        for (const session of this.#sessions.values()) session.admission.refill(simRate);
        this.#loop.step(this.#rt.tick + 1);
        // After the step, so a gap seq is dated against the tick the window has actually reached.
        const grace = pastGraceTicks(simRate);
        for (const session of this.#sessions.values()) {
            session.admission.abandonStale(this.#rt.tick, grace);
        }
    }

    /** Closes a session that has not joined inside the deadline — the one denial needing no frame at all. */
    #sweepJoinDeadline(): void {
        const deadline = joinDeadlineTicks(this.#rt.simRate);
        // Collected, then closed: closing mutates the registry, and a sweep that did it mid-iteration
        // would be relying on that being safe rather than stating it.
        const expired: Session[] = [];
        for (const session of this.#sessions.values()) {
            if (session.joined || session.closed) continue;
            if (this.#rt.tick - session.openedAtTick >= deadline) expired.push(session);
        }
        for (const session of expired) this.#closeFor(session, 'join-deadline');
    }

    /** A send-tick: drain the three channels once, fan them out, then answer any pending join. */
    #drain(nowMs: number): void {
        const set = drainOnce(
            this.#rt,
            this.#rt.tick,
            this.#roster,
            this.#spill,
            MAX_STRUCTURAL_OPS_PER_SEND,
        );
        this.#roster.joins.length = 0;
        this.#roster.leaves.length = 0;
        this.#dropped += set.dropped;
        this.#stale += set.staleMarks;

        const broadcasting: ConnectionId[] = [];
        for (const session of this.#sessions.values()) {
            if (session.wantsBroadcast) broadcasting.push(session.connectionId);
        }

        // Ahead of the fan-out, never after: this send's journal may spawn the first entity of a
        // template these peers have not been told about, and a node created against a table that
        // does not hold it yet draws the placeholder and keeps it. A session still awaiting its
        // `Welcome` is skipped, since its snapshot already carries the whole manifest.
        const additions = this.#visuals.drain();
        if (additions !== null) {
            this.#send(broadcasting, { kind: 'manifest', visuals: additions }, 'reliable');
        }

        for (const session of this.#sessions.values()) {
            const player = session.livePlayer;
            if (player === null) continue;
            if (session.wantsBroadcast) {
                // Reliable first: the client holds a transform envelope until the state envelope for
                // that tick has been applied.
                this.#send(
                    [session.connectionId],
                    stateEnvelopeFor(session, player, set),
                    'reliable',
                );
                continue;
            }
            const pending = session.pendingJoin;
            if (pending === null) continue;
            session.structuralSkip = this.#spill.length;
            this.#welcome(session, player, pending, nowMs);
            session.pendingJoin = null;
        }

        // One envelope, however many peers take it: most of a state envelope is per-connection, so
        // this is the whole of the shared subset and the only thing worth encoding once.
        this.#send(broadcasting, transformEnvelope(set), 'droppable');

        // Answered after the drain, so a reply names the tick the world has actually reached.
        for (const session of this.#sessions.values()) {
            const sync = session.pendingTimeSync;
            if (sync === null) continue;
            session.pendingTimeSync = null;
            this.#send(
                [session.connectionId],
                {
                    kind: 'time-sync-reply',
                    clientSentMs: sync.clientSentMs,
                    serverSentMs: nowMs,
                    serverTick: this.#rt.tick,
                },
                'reliable',
            );
        }
    }

    /** The `Welcome`, split across `snapshot-chunk` frames when the world is too big for one. */
    #welcome(session: Session, player: Player, request: JoinRequest, nowMs: number): void {
        const welcome: Welcome = {
            kind: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            yourPlayerId: player.id,
            yourPlayerIndex: player.index,
            projectId: this.#project.projectId,
            projectHash: this.#project.projectHash,
            bundleHash: this.#project.bundleHash,
            bundleUrl: this.#project.bundleUrl,
            simRate: this.#rt.simRate,
            sendRate: this.#config.sendRate,
            bounds: this.#bounds,
            regions: this.#regions,
            // Echoed byte-identically: only the client differences its own stamps, so a server stamp
            // differenced against a client one would yield RTT plus an unknown clock offset.
            clientSentMs: request.clientSentMs,
            serverSentMs: nowMs,
            snapshot: buildSnapshot(this.#rt, player),
            visuals: this.#visuals.snapshot(),
        };

        // Measured rather than counted, so a world that fits pays one encode and nothing else.
        if (measure(welcome, this.#codec) <= MAX_FRAME_PAYLOAD_BYTES) {
            this.#send([session.connectionId], welcome, 'reliable');
            return;
        }
        const split = splitSnapshot(welcome.snapshot, this.#codec, MAX_FRAME_PAYLOAD_BYTES);
        this.#dropped += split.dropped;
        // Chunks first, then the `Welcome` that closes the set: the client holds them until the
        // `Welcome` names how many there were, so it never applies half a world.
        for (const chunk of split.chunks) this.#send([session.connectionId], chunk, 'reliable');
        this.#send(
            [session.connectionId],
            { ...welcome, snapshot: split.head, snapshotChunks: split.chunks.length },
            'reliable',
        );
    }

    /** The host reported a session gone: release it, whether it closed itself or was closed here. */
    #drop(connectionId: ConnectionId): void {
        const session = this.#sessions.get(connectionId);
        if (session !== undefined) this.#release(session);
    }

    /** The per-session close path: drop it from the registry, then release the player it held. */
    #release(session: Session): void {
        if (session.closed) return;
        session.closed = true;
        this.#sessions.delete(session.connectionId);
        this.#buffer.dropSession(session);

        const player = session.player;
        if (player === null) return;
        session.player = null;

        // Found by owner scan, never `player.avatar`, which throws for a spectator.
        for (const id of this.#rt.entities.liveIds()) {
            if (this.#rt.entities.record(id)?.ownerId === player.id) {
                this.#rt.entityManager.destroy(id);
            }
        }
        // Taken before the leave and read after it: `@onPlayerLeave` may write a final value, but
        // `PlayerManager.remove` then drops the record from the host table.
        const record = this.#rt.hosts.get(playerKey(player.id))?.record;
        leavePlayer(this.#rt, player.id);
        // Only a host-named peer, since only a host-named peer can ever read it back: a connection
        // id is minted fresh per socket, so writing one durably leaks an entry per join/leave cycle.
        if (record !== undefined && session.identity !== null && this.#records.has(record.hostId)) {
            this.#saves.push(this.#records.capture(record));
        }
        this.#roster.leaves.push(player.id);
    }
}

/** One envelope's encoded size, or infinity for one the codec refuses — which is over any budget. */
function measure(envelope: ServerToClient, codec: Codec): number {
    try {
        return codec.byteLength(codec.encode(envelope as unknown as Message));
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

/** Whether an inbound frame names a message a client may send. */
function asClientEnvelope(message: unknown): ClientToServer | undefined {
    if (typeof message !== 'object' || message === null) return undefined;
    const kind = (message as { kind?: unknown }).kind;
    switch (kind) {
        case 'join-request':
            return isJoinRequest(message) ? message : undefined;
        case 'input':
            return isInputFrame(message) ? message : undefined;
        case 'interaction':
            return isInteractionFrame(message) ? message : undefined;
        case 'request':
            return isRequestFrame(message) ? message : undefined;
        case 'time-sync':
            return isTimeSync(message) ? message : undefined;
        default:
            return undefined;
    }
}

/** Every field, checked — not `Partial<JoinRequest>`, which claims the narrowing without doing it. */
function isJoinRequest(message: object): message is JoinRequest {
    const m = message as Record<string, unknown>;
    return (
        typeof m['protocolVersion'] === 'number' &&
        typeof m['name'] === 'string' &&
        typeof m['clientSentMs'] === 'number' &&
        isIdentityString(m['projectId']) &&
        isIdentityString(m['projectHash']) &&
        isIdentityString(m['bundleHash'])
    );
}

/** An identity field: a string this server will compare, short enough to compare. Empty is legal and meaningful. */
function isIdentityString(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_IDENTITY_LENGTH;
}

function isInteractionFrame(message: object): message is InteractionFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick'])) return false;
    const events = m['events'];
    if (!Array.isArray(events) || events.length > MAX_INTERACTIONS_PER_FRAME) return false;
    return events.every(isInteraction);
}

function isInteraction(value: unknown): value is Interaction {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    switch (e['kind']) {
        case 'press':
            // `screen` is checked with `in` rather than by value: the wire rule is
            // absent-not-undefined, and an explicit `undefined` is a frame no codec could produce.
            if (!isWidgetName(e['widget'])) return false;
            return !('screen' in e) || isWidgetName(e['screen']);
        case 'click':
        case 'hover-enter':
        case 'hover-exit':
            return Number.isSafeInteger(e['netId']) && (e['netId'] as number) >= 0;
        default:
            return false;
    }
}

function isWidgetName(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value.length <= MAX_WIDGET_NAME_LENGTH;
}

function isRequestFrame(message: object): message is RequestFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick'])) return false;
    const requests = m['requests'];
    if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_FRAME) return false;
    return requests.every(isGameRequest);
}

function isGameRequest(value: unknown): value is GameRequest {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    const name = r['name'];
    if (typeof name !== 'string' || name === '' || name.length > MAX_REQUEST_NAME_LENGTH) {
        return false;
    }
    // Checked with `in` rather than by value, because an explicit `undefined` is a frame no codec
    // could have produced and the wire rule is absent-not-undefined.
    if (!('data' in r)) return true;
    return isPlainObject(r['data']) && isBoundedPayload(r['data']);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a payload's whole graph fits inside `MAX_REQUEST_PAYLOAD_NODES`.
 *
 * Iterative rather than recursive, for the reason the codec's own walk is: a frame nesting a few
 * thousand deep is well-formed and small, and would overflow the stack before any cap read it. The
 * node count is what bounds this walk, and depth can never exceed it — a peer-chosen graph the
 * handler is handed whole is the one place a cardinality cap alone would not.
 */
function isBoundedPayload(payload: Record<string, unknown>): boolean {
    const stack: unknown[] = [payload];
    let nodes = 0;
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || typeof node !== 'object') continue;
        for (const child of Object.values(node)) {
            if (++nodes > MAX_REQUEST_PAYLOAD_NODES) return false;
            stack.push(child);
        }
    }
    return true;
}

function isTimeSync(message: object): message is TimeSync {
    return typeof (message as Partial<TimeSync>).clientSentMs === 'number';
}

function isInputFrame(message: object): message is InputFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick']) || !Number.isSafeInteger(m['seq'])) return false;
    const actions = m['actions'];
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS_PER_FRAME) return false;
    return actions.every(isInputAction);
}

function isInputAction(value: unknown): value is InputAction {
    if (typeof value !== 'object' || value === null) return false;
    const a = value as Record<string, unknown>;
    const action = a['action'];
    if (typeof action !== 'string' || action === '' || action.length > MAX_ACTION_NAME_LENGTH) {
        return false;
    }
    if (a['on'] !== 'press' && a['on'] !== 'release' && a['on'] !== 'hold') return false;
    // Checked with `in` rather than by value, because an explicit `undefined` is a frame no codec
    // could have produced and the wire rule is absent-not-undefined.
    return !('value' in a) || Number.isFinite(a['value']);
}

/** Untrusted: the server sanitizes and may replace it. */
function sanitizeName(name: string): string {
    // Format characters go with the controls: a bidi override or a zero-width joiner renders as
    // nothing while reordering everything after it, which is a display name's griefing surface.
    const stripped = name
        .normalize('NFC')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim();
    // Trimmed again because the code-point cut can land on a space.
    const capped = [...stripped].slice(0, MAX_NAME_LENGTH).join('').trim();
    return capped === '' ? 'player' : capped;
}

/** Math's `Bounds` is an interface, so it has no implicit index signature and is copied field by field rather than spread. */
function toWireBounds(bounds: Bounds): WireBounds {
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
}

/** The subset core's manifest takes; the `url` is the wire's alone. */
function assetManifestEntry(asset: RenderManifest['assets'][number]): {
    key: string;
    kind: RenderManifest['assets'][number]['kind'];
    meta?: { width?: number; height?: number; duration?: number };
} {
    return {
        key: asset.key,
        kind: asset.kind,
        ...defined({ meta: asset.meta }),
    };
}

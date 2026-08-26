// GameServer: the connection registry, the join sequence, and the close path.
//
// The transport interface is one end of one connection, and standing up a listener is a factory
// concern — so this is the missing multiplexer, the piece transport declined to hold. The server never
// opens a socket: transports arrive from a loopback pair or a WebSocket listener, and the composition
// root wires the factory's output into `accept`.

import type { Bounds } from '@platform/math';
import type {
    BreakerTrip,
    EngineConfig,
    GameManifest,
    HostRecord,
    KVStore,
    Player,
    Runtime,
} from '@platform/core';
import {
    Asset,
    AssetRegistry,
    Loop,
    PersistedState,
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
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    JoinRequest,
    ProjectId,
    Reject,
    RejectReason,
    RenderManifest,
    TimeSync,
    Welcome,
    WireBounds,
    WireRegion,
    WireStructuralOp,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { Codec, Message, TimerSource, Transport } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { Connection } from './connection.js';
import type { RosterOps } from './broadcast.js';
import { broadcastTo, drainOnce, readPlayerSnapshot, send } from './broadcast.js';
import { splitSnapshot } from './chunk.js';
import {
    JOIN_DEADLINE_MS,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_STRUCTURAL_OPS_PER_SEND,
    MAX_ACTIONS_PER_FRAME,
    MAX_INTERACTIONS_PER_FRAME,
    MAX_WIDGET_NAME_LENGTH,
    MAX_ACTION_NAME_LENGTH,
    MAX_IDENTITY_LENGTH,
    MAX_NAME_LENGTH,
    MAX_UNJOINED_CONNECTIONS,
    RATE_BREACH_CLOSE,
    assertRate,
    pastGraceTicks,
} from './constants.js';
import { Driver } from './driver.js';
import type { PumpResult } from './driver.js';
import { InputBuffer, runInputPass } from './input.js';
import { ManifestStore } from './manifest.js';
import { buildSnapshot } from './snapshot.js';

/**
 * What this process is running, proved against every joiner's claim before a `Player` is allocated.
 *
 * The hashes are opaque here: the server compares, it does not compute. Whoever built the project
 * knows what went into it, and a server that derived its own would be checking itself.
 */
export interface ProjectIdentity {
    projectId: ProjectId;
    projectHash: string;
    /** Lowercase-hex SHA-256 of the bytes at `bundleUrl`; `''` when this server serves no bundle. */
    bundleHash: string;
    /** Fetched by the browser over HTTP, never sent down this socket. `''` for no bundle. */
    bundleUrl: string;
}

/**
 * A server that declares no project. Every field empty, which is exactly what a client that declares
 * none sends — so the two agree, and any one-sided declaration is a mismatch rather than a pass.
 */
const UNIDENTIFIED: ProjectIdentity = {
    projectId: '',
    projectHash: '',
    bundleHash: '',
    bundleUrl: '',
};

/**
 * The class → id edge core needs, as `@platform/scripting`'s `ScriptRegistry` already provides it.
 *
 * Declared structurally rather than imported: that package imports core, and the server needs one
 * method off whatever registry a host built.
 */
export interface ScriptIndex {
    idOf(klass: abstract new (...args: never[]) => object): ScriptId | undefined;
}

/**
 * The server's own load-time input, carrying what core's manifest cannot: `sendRate` and `maxPlayers`
 * have no reader in core, and the render manifest has no source there at all.
 */
export interface ServerConfig extends Partial<EngineConfig> {
    bounds?: Bounds;
    regions?: Array<{ name: string; bounds: Bounds }>;
    /** Panel-authored art, passed through to `Welcome.visuals`. */
    visuals?: RenderManifest;
    /** Game-hosted `ServerScript` classes, forwarded to `loadGame`. */
    gameScripts?: GameManifest['gameScripts'];
    /**
     * What every spawn key means, from `toGameManifest(validate(file), …)`.
     *
     * Built before the scene, because instantiating one is what puts a template's scripts and
     * subtree on an entity — a world built against an empty registry is a world of bare entities.
     */
    templates?: GameManifest['templates'];
    /** The placed world, parents before children — instantiated before the first `accept`. */
    entities?: GameManifest['entities'];
    /**
     * Names a script class on the wire, from the registry this process loaded its bundle into.
     *
     * Without it no `attach` op is journaled at all: the op names an id, and a class name is no
     * contract across a minifier or a process boundary.
     */
    scripts?: ScriptIndex;
    /** What this build is. Omitted, every joiner declaring nothing is admitted and nothing else. */
    project?: ProjectIdentity;
    /**
     * Where `@serverState` outlives a session. Real owner: the host app.
     *
     * Omitted, core's `MemoryKVStore` stands in, so persistence is exercisable with no host at all —
     * and dies with the process, which is the honest behaviour for a store nobody supplied.
     */
    kv?: KVStore;
}

export interface GameServerOptions {
    config?: ServerConfig;
    /** Process-wide, injected once. Defaults to transport's `jsonCodec`. */
    codec?: Codec;
    /** The loopback pair's `deliver`; omitted networked. */
    deliver?: () => void;
    /** The scheduling seam for a self-driven server. */
    timer?: TimerSource;
    /** The clock a self-driven server reads; `TimerSource` schedules but does not tell time. */
    now?: () => number;
    /**
     * Called when the breaker disables a script's handler or callback after consecutive throws.
     *
     * The dev channel, and deliberately not an envelope: a disabled handler is something whoever
     * runs the server has to see, while a player's client can neither act on it nor be trusted with
     * a stack. Its own throw is contained, so a reporting bug cannot end a tick.
     */
    onBreakerTrip?: (trip: BreakerTrip) => void;
}

export class GameServer {
    /** Live connections, keyed by connectionId — the collection transport does not hold. */
    readonly #connections = new Map<string, Connection>();
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
    readonly #driver: Driver;
    /** Roster ops awaiting the next send — core's journal has no arm for either. */
    readonly #roster: RosterOps = { joins: [], leaves: [] };
    /**
     * Structural ops over this send's budget, kept in order for the next one.
     *
     * The only server state that survives a send set, and deliberately so: an op held over is one the
     * peers have not been told about, so dropping it on the floor would leave every mirror wrong.
     */
    readonly #spill: WireStructuralOp[] = [];
    readonly #started: Promise<void>;
    /** `@serverState` that outlives a session — read synchronously, written through at a leave. */
    readonly #persisted: PersistedState;

    #nextConnectionId = 1;
    /** Marks and ops dropped as unrepresentable, cumulative. */
    #dropped = 0;
    #closed = false;
    /** False until the world exists; `accept` refuses while it is. */
    #booted = false;

    constructor(opts: GameServerOptions = {}) {
        const config = opts.config ?? {};
        this.#config = resolveConfig(config);
        if (!Number.isInteger(this.#config.maxPlayers) || this.#config.maxPlayers < 1) {
            throw new RangeError(
                `maxPlayers must be a positive integer, received ${this.#config.maxPlayers}`,
            );
        }
        this.#codec = opts.codec ?? jsonCodec;

        // Built first, and the only thing that checks the two rates: `resolveConfig` fills defaults
        // without validating, and a `simRate` of 0 makes `dt` infinite, so the accumulator never
        // reaches it and the world steps zero times forever. Ahead of `loadGame` so a bad rate
        // refuses before a world is built rather than after.
        this.#driver = new Driver(
            { stepOnce: () => this.#stepOnce(), send: () => this.#send() },
            {
                simRate: this.#config.simRate,
                sendRate: this.#config.sendRate,
                ...(opts.deliver === undefined ? {} : { deliver: opts.deliver }),
                ...(opts.timer === undefined ? {} : { timer: opts.timer }),
                ...(opts.now === undefined ? {} : { now: opts.now }),
            },
        );

        const bounds = config.bounds ?? { left: -400, right: 400, top: 300, bottom: -300 };
        this.#bounds = toWireBounds(bounds);
        this.#regions = (config.regions ?? []).map((r) => ({
            name: r.name,
            bounds: toWireBounds(r.bounds),
        }));
        this.#visuals = new ManifestStore(config.visuals);
        this.#project = config.project ?? UNIDENTIFIED;

        // `role: 'server'` is the location filter: it makes the loop dispatch only server and synced
        // handlers, so client-only scripts are inert here, which is the trust boundary. Every other
        // seam is left at core's null default.
        //
        // Boot order lives inside this one call: the template registry is built, the Game scripts
        // are wired, and the placed scene is instantiated against that registry — so nothing can
        // observe a world whose spawn keys mean nothing yet.
        this.#rt = loadGame(
            {
                role: 'server',
                simRate: this.#config.simRate,
                bounds,
                ...(config.regions === undefined ? {} : { regions: config.regions }),
                ...(config.visuals === undefined
                    ? {}
                    : { assets: config.visuals.assets.map((a) => assetManifestEntry(a)) }),
                ...(config.templates === undefined ? {} : { templates: config.templates }),
                ...(config.entities === undefined ? {} : { entities: config.entities }),
                ...(config.gameScripts === undefined ? {} : { gameScripts: config.gameScripts }),
            },
            config.scripts === undefined
                ? {}
                : { scriptIdOf: (klass) => config.scripts?.idOf(klass) },
        );
        this.#loop = new Loop(this.#rt);

        // The persistence seam's two missing halves. Core declares `kv` and reads `persisted`, and
        // until now nothing assigned either — so a store was injectable and never injected, and the
        // seeding path in wiring had no producer to read from.
        if (config.kv !== undefined) this.#rt.kv = config.kv;
        this.#persisted = new PersistedState(this.#rt.kv);
        this.#rt.persisted = this.#persisted;

        // Registered before `startGame` below, so a Game `@onStart` that trips the breaker on its
        // very first tick is still reported.
        if (opts.onBreakerTrip !== undefined) this.#rt.dispatcher.onTrip(opts.onBreakerTrip);

        // The one seam the server itself fills, installed before the first step so no tick ever runs
        // against core's stub. A missing pass table would leave every input silently unapplied, which
        // reads as a dead game rather than as a wiring fault.
        const passes = this.#rt.passes;
        if (passes === undefined) {
            throw new Error(
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
                        connections: () => this.#connections.values(),
                    },
                    dispatch,
                ),
        };

        // Not awaited. This promise settles when every Game start handler completes, and a handler
        // awaiting a timer cannot complete until the loop steps — so awaiting it here deadlocks the
        // server against its own driver. It runs to each handler's first await synchronously, which is
        // the guarantee that matters: world construction that must precede a join belongs before it.
        this.#started = startGame(this.#rt);

        // Last, so `accept` refuses until every step above has run. A connection admitted earlier
        // would be answered with a `Welcome` whose snapshot is a world still being built, and a
        // joiner's baseline is the one thing no later delta repairs.
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

    /** Live connections in accept order. */
    get connections(): Connection[] {
        return [...this.#connections.values()];
    }

    /** Whether the world is built, and so whether `accept` will admit anything. */
    get booted(): boolean {
        return this.#booted;
    }

    /**
     * Registers one established connection and returns its id, or `null` if it was refused and closed.
     *
     * It sends no frame and mutates no roster, because the client speaks first — and handlers are
     * registered before any state mutation, so no frame arriving during join is dropped.
     *
     * The refusal is `null` rather than an id: the unjoined cap is distinct from `maxPlayers` so that
     * unjoined sockets cannot lock out real players, and handing back an id for a socket this call just
     * closed reads at the composition root as a connection that is still live. A connection offered
     * before the world is built is refused the same way — a joiner's snapshot is its whole baseline.
     */
    accept(transport: Transport): string | null {
        if (!this.#booted || this.#closed || this.#unjoinedCount() >= MAX_UNJOINED_CONNECTIONS) {
            transport.close();
            return null;
        }

        const connectionId = `c${this.#nextConnectionId++}`;
        // Null, not the current reading, before the first wake: the injected clock's epoch is unknown
        // — a host passing `Date.now() / 1000` reads 1.7e9 — so stamping 0 here and differencing
        // against it would expire every connection accepted before the loop started.
        const conn = new Connection(
            connectionId,
            transport,
            this.#driver.hasReading ? this.#driver.nowSeconds : null,
        );

        conn.disposers.push(transport.onMessage((message) => this.#receive(conn, message)));
        conn.disposers.push(transport.onClose(() => this.#onTransportClosed(conn)));

        this.#connections.set(connectionId, conn);
        return connectionId;
    }

    /** One wake. The driver owns the deliver→step sequence; this is the whole host API. */
    pump(nowSeconds: number): PumpResult {
        if (this.#closed) return { steps: 0, sends: 0, shed: false };
        const result = this.#driver.pump(nowSeconds);
        // Swept after the pump, so a join request this wake's delivery was about to flush is already
        // processed and its connection no longer counts as unjoined.
        this.#sweepJoinDeadline(nowSeconds);
        return result;
    }

    /** Networked: self-drive off the injected timer. */
    start(): void {
        if (this.#closed) throw new Error('GameServer is closed and cannot be started');
        this.#driver.start();
    }

    /** Stops the driver, leaving every connection open — `close()` is the shutdown. */
    stop(): void {
        this.#driver.stop();
    }

    /**
     * Shuts the server down: stops the driver, closes every connection, and refuses later `accept`s.
     * Idempotent.
     *
     * The close path is run directly rather than left to each transport's `onClose`, which fires on the
     * next delivery — and after this there is no next delivery, so waiting would leak every `Player` and
     * every registered handler.
     */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#driver.stop();
        // Deleting the entry the iterator has already yielded is well-defined, which is what lets the
        // close path run inline here rather than over a snapshot.
        for (const conn of this.#connections.values()) {
            conn.transport.close();
            this.#onTransportClosed(conn);
        }
    }

    /**
     * Declares visuals for templates that have come into use since boot.
     *
     * Idempotent per name, so the ordinary call — announcing a template about to be spawned — costs
     * nothing after the first. Whatever is new reaches connected peers on the next send and every
     * later joiner through `Welcome.visuals`, so the two paths cannot disagree about what a session
     * can draw. Core's asset table is defined alongside, or `assets.get` would answer `null` for a
     * key the wire is already carrying.
     */
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

    /**
     * Changes the timestep mid-session and tells every client, which treats it as a resync trigger
     * rather than a live retune — core retunes neither a pending timer nor the lag ring.
     */
    setSimRate(simRate: number): void {
        assertRate('simRate', simRate);
        this.#rt.setSimRate(simRate);
        this.#driver.setRates(simRate, this.#config.sendRate);
        for (const conn of this.#connections.values()) {
            if (conn.joined)
                send(conn.transport, { kind: 'rate-change', tick: this.#rt.tick, simRate });
        }
    }

    #stepOnce(): void {
        const simRate = this.#rt.simRate;
        for (const conn of this.#connections.values()) conn.admission.refill(simRate);
        this.#loop.step(this.#rt.tick + 1);
        // After the step, so a gap seq is dated against the tick the window has actually reached.
        const grace = pastGraceTicks(simRate);
        for (const conn of this.#connections.values()) {
            conn.admission.abandonStale(this.#rt.tick, grace);
        }
    }

    /**
     * A send-tick: drain the three channels once, fan them out, then answer any pending join.
     *
     * The `Welcome` is built here rather than at the join request, because a snapshot taken then sits on
     * the wrong side of the journal cut and the next send would replay ops it already holds — and a
     * duplicate spawn is not idempotent: the client mints a second entity and orphans the first.
     */
    #send(): void {
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

        // Ahead of the fan-out, never after: this send's journal may spawn the first entity of a
        // template these peers have not been told about, and a node created against a table that
        // does not hold it yet draws the placeholder and keeps it. A peer still awaiting its
        // `Welcome` is skipped, because the snapshot below already carries the whole manifest.
        const additions = this.#visuals.drain();

        for (const conn of this.#connections.values()) {
            if (conn.wantsBroadcast) {
                if (additions !== null) {
                    send(conn.transport, { kind: 'manifest', visuals: additions });
                }
                broadcastTo(conn, set, this.#codec);
                continue;
            }
            // Skipped by the broadcast above, because everything in this set predates the snapshot it
            // is about to receive.
            const pending = conn.pendingJoin;
            if (pending === null || conn.closed || conn.player === null) continue;
            conn.pendingJoin = null;
            // What is still held over is already in the snapshot, which reads live state — so this
            // connection owes those ops a skip, and every later one is genuinely new to it.
            conn.structuralSkip = this.#spill.length;
            this.#sendWelcome(conn, this.#welcome(conn.player, pending));
        }
    }

    /**
     * Sends a `Welcome`, split across `snapshot-chunk` frames when the world is too big for one.
     *
     * Encoded once and measured, then sent as the frame that was measured: `sendEncoded` skips the
     * peer's own encode, so the common case pays nothing for the check. Only a snapshot that would be
     * refused by transport is walked a second time to be divided.
     */
    #sendWelcome(conn: Connection, welcome: Welcome): void {
        const frame = this.#codec.encode(welcome as unknown as Message);
        if (this.#codec.byteLength(frame) <= MAX_FRAME_PAYLOAD_BYTES) {
            conn.transport.sendEncoded(frame);
            return;
        }
        const split = splitSnapshot(welcome.snapshot, this.#codec, MAX_FRAME_PAYLOAD_BYTES);
        this.#dropped += split.dropped;
        // Chunks first, then the `Welcome` that closes the set: the client holds them until the
        // `Welcome` names how many there were, so it never applies half a world.
        for (const chunk of split.chunks) send(conn.transport, chunk);
        send(conn.transport, {
            ...welcome,
            snapshot: split.head,
            snapshotChunks: split.chunks.length,
        });
    }

    /**
     * Narrows one inbound frame: a type is a compile-time claim and the bytes are a runtime fact, so
     * this checks rather than casts.
     *
     * A frame it cannot name is ignored and the connection survives — a malformed frame must not be
     * able to end a session it does not own.
     */
    #receive(conn: Connection, message: Message): void {
        if (conn.closed) return;
        const envelope = asClientEnvelope(message);
        if (envelope === undefined) return;
        // A join request buys a full world walk and a time-sync buys a reply, and the input bucket
        // covers neither, so they draw on a second and far shallower one. An interaction is not on
        // it: it is the same shape of cost as an input frame — one per tick, bounded contents — and
        // charging both to one bucket is what keeps a peer's TOTAL per-tick work bounded rather than
        // letting a second channel double it.
        const onInputBucket = envelope.kind === 'input' || envelope.kind === 'interaction';
        if (!onInputBucket && !conn.admission.takeControlToken()) return;
        // Any well-formed frame restarts the stale-hold clock. Input alone is not evidence of
        // liveness: the client sends edges only, so a player holding one button sends one frame and
        // then nothing, and a time-sync is the one thing a live client sends unprompted.
        if (conn.joined) conn.admission.noteTraffic(this.#rt.tick);
        switch (envelope.kind) {
            case 'join-request':
                this.#join(conn, envelope);
                return;
            case 'input':
                this.#input(conn, envelope);
                return;
            case 'interaction':
                this.#interaction(conn, envelope);
                return;
            case 'time-sync':
                this.#timeSync(conn, envelope);
                return;
        }
    }

    /**
     * The join sequence, in the order the checks must run: version, then identity — both before
     * anything is built — then capacity before anything is allocated, and a `Reject` before the close.
     *
     * Identity sits above capacity because a client running other code is refused whether or not
     * there is room, and "full" would send it away to retry a refusal that is not about room.
     *
     * A bare close is indistinguishable from a drop, and the right client responses invert: a drop
     * should offer a rejoin, a version mismatch must never retry, and full is not a network error.
     */
    #join(conn: Connection, request: JoinRequest): void {
        // A resync on a joined connection is answered rather than dropped: the client has already
        // cleared its mirror, clock and ring, so ignoring it leaves a session nothing ever closes.
        // No second Player and no roster op — every peer already knows this one.
        if (conn.joined) {
            if (request.protocolVersion !== PROTOCOL_VERSION) this.#reject(conn, 'version');
            // Re-checked on the resync too: the client may have loaded a bundle since it joined, and
            // a session that started matching can stop.
            else if (!this.#identityMatches(request)) this.#reject(conn, 'identity');
            else conn.pendingJoin = request;
            return;
        }

        if (request.protocolVersion !== PROTOCOL_VERSION) {
            this.#reject(conn, 'version');
            return;
        }
        if (!this.#identityMatches(request)) {
            this.#reject(conn, 'identity');
            return;
        }
        const roster = this.#rt.playerManager?.players.length ?? 0;
        if (roster >= this.#config.maxPlayers) {
            this.#reject(conn, 'full');
            return;
        }

        // The index is the PlayerManager's to assign, never the server's, so the client mirrors it off
        // the wire rather than renumbering from its own arrival order.
        const player = joinPlayer(this.#rt, conn.connectionId, sanitizeName(request.name));
        conn.player = player;
        conn.admission.noteTraffic(this.#rt.tick);

        // The request itself is held, not a flag: only it carries the `clientSentMs` to echo.
        conn.pendingJoin = request;

        // Queued rather than sent, so the next broadcast prepends it ahead of the spawns the join
        // handler just produced.
        this.#roster.joins.push(readPlayerSnapshot(player));
    }

    /**
     * Whether a joiner is running what this server is running.
     *
     * The project and its build must agree exactly. A `bundleHash` of `''` is the one asymmetry: it
     * means the client holds no bundle yet and will fetch the one this welcome names, so it is not a
     * disagreement — a non-empty one that differs is a client running stale code, which prediction
     * would replay through and report as jitter.
     */
    #identityMatches(request: JoinRequest): boolean {
        if (request.projectId !== this.#project.projectId) return false;
        if (request.projectHash !== this.#project.projectHash) return false;
        return request.bundleHash === '' || request.bundleHash === this.#project.bundleHash;
    }

    /** Exactly protocol's fields, with `reconnectToken` omitted — the MVP mints none. */
    #welcome(player: Player, request: JoinRequest): Welcome {
        return {
            kind: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            yourPlayerId: player.id,
            yourPlayerIndex: player.index,
            projectId: this.#project.projectId,
            projectHash: this.#project.projectHash,
            bundleHash: this.#project.bundleHash,
            bundleUrl: this.#project.bundleUrl,
            simRate: this.#rt.simRate,
            // From the server's own config, because core resolves nothing: a client cannot assume 20,
            // since it sizes its interpolation delay off this number.
            sendRate: this.#config.sendRate,
            bounds: this.#bounds,
            regions: this.#regions,
            // Echoed byte-identically: only the client differences its own stamps, so a server stamp
            // differenced against a client one would yield RTT plus an unknown clock offset.
            clientSentMs: request.clientSentMs,
            serverSentMs: this.#driver.nowSeconds * 1000,
            snapshot: buildSnapshot(this.#rt, player),
            visuals: this.#visuals.snapshot(),
        };
    }

    #reject(conn: Connection, reason: RejectReason): void {
        const reject: Reject = { kind: 'reject', reason, serverProtocolVersion: PROTOCOL_VERSION };
        send(conn.transport, reject);
        conn.transport.close();
    }

    #input(conn: Connection, frame: InputFrame): void {
        // An input frame before the join has no player to attribute to, and identity is the one thing
        // the server never takes from a frame.
        if (!conn.joined) return;
        const result = this.#buffer.admit(conn, frame, this.#rt.tick, this.#rt.simRate);

        // A sustained breach closes the connection, not a single burst: the bucket already absorbs the
        // jitter a healthy client produces, so past this many refusals the peer is buggy or hostile
        // either way. It closes that connection and no other.
        if (
            result.kind === 'refused' &&
            result.reason === 'rate' &&
            conn.admission.rateRefusals >= RATE_BREACH_CLOSE
        ) {
            conn.transport.close();
        }
    }

    /**
     * Queues a frame's interactions for the tick pass, which is where they are dispatched.
     *
     * Queued rather than dispatched here: a handler reached from a socket callback would run outside
     * any tick, so `rt.tick` would name whatever the loop last adopted and a `@onPress` that spawns
     * would land between passes. The queue is drained every tick and the input bucket already bounds
     * how many frames reach it, so it needs no depth of its own.
     */
    #interaction(conn: Connection, frame: InteractionFrame): void {
        // Identity comes from the connection, so an interaction before the join has nobody to blame.
        if (!conn.joined) return;
        if (!conn.admission.takeToken()) {
            if (conn.admission.rateRefusals >= RATE_BREACH_CLOSE) conn.transport.close();
            return;
        }
        for (const event of frame.events) conn.interactions.push(event);
    }

    #timeSync(conn: Connection, sync: TimeSync): void {
        send(conn.transport, {
            kind: 'time-sync-reply',
            clientSentMs: sync.clientSentMs,
            serverSentMs: this.#driver.nowSeconds * 1000,
            serverTick: this.#rt.tick,
        });
    }

    /**
     * The per-connection close path, in order: drop it from the registry so the next broadcast skips it,
     * run the disposers so no handler leaks, then release the player. No grace timer yet, so the release
     * is immediate.
     */
    #onTransportClosed(conn: Connection): void {
        if (conn.closed) return;
        conn.closed = true;
        this.#connections.delete(conn.connectionId);
        this.#buffer.dropConnection(conn);
        conn.dispose();

        const player = conn.player;
        if (player === null) return;
        conn.player = null;

        // Destroyed before the leave, or the leave handler sees a world where the avatar's owner is
        // already null. Found by owner scan, never `player.avatar`, which throws for a spectator.
        for (const id of this.#rt.entities.liveIds()) {
            if (this.#rt.entities.record(id)?.ownerId === player.id) {
                this.#rt.entityManager.destroy(id);
            }
        }
        // Taken before the leave and read after it: `@onPlayerLeave` runs inside `leavePlayer` and
        // may write a final value, but `PlayerManager.remove` then drops the record from the host
        // table — so the reference has to be captured first, and the fields read second.
        const record = this.#rt.hosts.get(playerKey(player.id))?.record;
        leavePlayer(this.#rt, player.id);
        if (record !== undefined) this.#persist(record);
        this.#roster.leaves.push(player.id);
    }

    /**
     * Writes a departing player's `@serverState` through to the store — the session boundary this
     * server owns, and the only one that exists.
     *
     * Fire-and-forget, with the failure routed to the engine log. The trigger is a socket that has
     * already closed, so nothing is waiting on the answer; making the close path async to carry one
     * would push a promise up through `transport.onClose` and `GameServer.close()`, neither of which
     * has anywhere to put it. `PersistedState` captures synchronously for exactly this reason, so a
     * rejoin reads the value back whether or not the write to the store has landed.
     */
    #persist(record: HostRecord): void {
        this.#persisted.save(record).catch((error: unknown) => {
            this.#rt.log.warn(
                `persisting ${record.hostId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    }

    #unjoinedCount(): number {
        let n = 0;
        for (const conn of this.#connections.values()) if (!conn.joined) n += 1;
        return n;
    }

    /**
     * Closes a connection that has not joined inside the deadline — the one denial needing no frame at
     * all, measured against the pump's own clock, which is the only clock the server has.
     */
    #sweepJoinDeadline(nowSeconds: number): void {
        if (!Number.isFinite(nowSeconds)) return;
        const deadline = JOIN_DEADLINE_MS / 1000;
        // Collected, then closed: `close()` never fires its handler synchronously, but a sweep that
        // mutated the registry mid-iteration would be relying on that rather than stating it.
        const expired: Connection[] = [];
        for (const conn of this.#connections.values()) {
            if (conn.joined || conn.closed) continue;
            if (conn.acceptedAtSeconds === null) {
                conn.acceptedAtSeconds = nowSeconds;
                continue;
            }
            if (nowSeconds - conn.acceptedAtSeconds >= deadline) expired.push(conn);
        }
        for (const conn of expired) conn.transport.close();
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
        case 'time-sync':
            return isTimeSync(message) ? message : undefined;
        default:
            return undefined;
    }
}

/**
 * Every field, checked — not `Partial<JoinRequest>`, which claims the narrowing without doing it:
 * a field added to the type stays absent from the check, so a frame missing it still narrows.
 *
 * A frame that fails this is malformed and ignored like any other, so a peer speaking an older
 * vocabulary is closed by the join deadline rather than told; the `version` reject can only refuse a
 * peer whose frames still parse, which is why `PROTOCOL_VERSION` moved with these fields.
 */
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

/**
 * An identity field: a string this server will compare, short enough to compare.
 *
 * Length-bounded like every other peer-chosen string here. Empty is legal and meaningful — it is how
 * a client says it declares no project, or holds no bundle yet.
 */
function isIdentityString(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_IDENTITY_LENGTH;
}

function isInteractionFrame(message: object): message is InteractionFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick'])) return false;
    const events = m['events'];
    // Length-bounded before the element walk, for the same reason `actions` is: the count is
    // peer-chosen and both this validation and the dispatch behind it are linear in it.
    if (!Array.isArray(events) || events.length > MAX_INTERACTIONS_PER_FRAME) return false;
    return events.every(isInteraction);
}

function isInteraction(value: unknown): value is Interaction {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    switch (e['kind']) {
        case 'press':
            // Both names become the event name of a dispatch, so both are length-bounded. `screen`
            // is checked with `in` rather than by value: the wire rule is absent-not-undefined, and
            // an explicitly-`undefined` key is a frame the codec could not have produced.
            if (!isWidgetName(e['widget'])) return false;
            return !('screen' in e) || isWidgetName(e['screen']);
        case 'click':
        case 'hover-enter':
        case 'hover-exit':
            // Only that it could name a handle. Whether it names one this player can reach is not
            // decidable here — the hit was resolved against a camera the server does not hold.
            return Number.isSafeInteger(e['netId']) && (e['netId'] as number) >= 0;
        default:
            return false;
    }
}

function isWidgetName(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value.length <= MAX_WIDGET_NAME_LENGTH;
}

function isTimeSync(message: object): message is TimeSync {
    return typeof (message as Partial<TimeSync>).clientSentMs === 'number';
}

function isInputFrame(message: object): message is InputFrame {
    const m = message as Record<string, unknown>;
    if (!Number.isSafeInteger(m['tick']) || !Number.isSafeInteger(m['seq'])) return false;
    const actions = m['actions'];
    // Length-bounded before the element walk: the count is peer-chosen, and both this validation and
    // the fold-and-dispatch behind it are linear in it, so one frame could otherwise buy unbounded
    // work that no per-frame rate limit sees.
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS_PER_FRAME) return false;
    return actions.every(isInputAction);
}

function isInputAction(value: unknown): value is InputAction {
    if (typeof value !== 'object' || value === null) return false;
    const a = value as Record<string, unknown>;
    const action = a['action'];
    // Length-bounded too: the name becomes a key in core's fold and the event name of a dispatch.
    if (typeof action !== 'string' || action === '' || action.length > MAX_ACTION_NAME_LENGTH) {
        return false;
    }
    if (a['on'] !== 'press' && a['on'] !== 'release' && a['on'] !== 'hold') return false;
    // Checked with `in` rather than by value, because an explicitly-`undefined` key is a frame the
    // codec could not have produced and the wire rule is absent-not-undefined. Finiteness is checked
    // here rather than left to the codec: an axis sample reaches `fillIntent` unmodified, and core
    // writes it straight into a `Float64Array`, so one non-finite sample poisons the world for good.
    return !('value' in a) || Number.isFinite(a['value']);
}

/** Untrusted: the server sanitizes and may replace it. */
function sanitizeName(name: string): string {
    // Controls and format characters both go. A control breaks a log line; a format character — a
    // bidi override, a zero-width joiner, the byte-order mark — renders as nothing while reordering
    // everything after it, which is a display name's whole griefing surface.
    const stripped = name
        .normalize('NFC')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim();
    // Cut by code point, never by UTF-16 unit, which would split a surrogate pair and leave a lone
    // half; trimmed again because the cut can land on a space.
    const capped = [...stripped].slice(0, MAX_NAME_LENGTH).join('').trim();
    return capped === '' ? 'player' : capped;
}

/**
 * Math's `Bounds` is an interface, so it has no implicit index signature and is not assignable to a
 * wire message — copied field by field rather than spread.
 */
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
        ...(asset.meta === undefined ? {} : { meta: asset.meta }),
    };
}

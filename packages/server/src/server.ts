import type { Bounds } from '@platform/math';
import { defined } from '@platform/math';
import type {
    BreakerTrip,
    EngineConfig,
    GameManifest,
    HostRecord,
    KVStore,
    LogSink,
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
    GameRequest,
    InputAction,
    InputFrame,
    Interaction,
    InteractionFrame,
    JoinRequest,
    ProjectId,
    Reject,
    RejectReason,
    RenderManifest,
    RequestFrame,
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
import type { RosterOps, SendSet } from './broadcast.js';
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
    MAX_REQUESTS_PER_FRAME,
    MAX_REQUEST_NAME_LENGTH,
    MAX_REQUEST_PAYLOAD_NODES,
    MAX_UNJOINED_CONNECTIONS,
    assertRate,
    pastGraceTicks,
} from './constants.js';
import { ServerError } from './errors.js';
import { Driver } from './driver.js';
import type { PumpResult } from './driver.js';
import { InputBuffer, runInputPass } from './input.js';
import { ManifestStore } from './manifest.js';
import { buildSnapshot } from './snapshot.js';

/** What this process is running, proved against every joiner's claim before a `Player` is allocated. */
export interface ProjectIdentity {
    projectId: ProjectId;
    projectHash: string;
    /** Lowercase-hex SHA-256 of the bytes at `bundleUrl`; `''` when this server serves no bundle. */
    bundleHash: string;
    /** Fetched by the browser over HTTP, never sent down this socket. `''` for no bundle. */
    bundleUrl: string;
}

/** A server that declares no project — every field empty, which is what a client declaring none sends, so agreement rather than absence is what passes. */
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

/** The server's own load-time input, carrying what core's manifest cannot. */
export interface ServerConfig extends Partial<EngineConfig> {
    bounds?: Bounds;
    regions?: Array<{ name: string; bounds: Bounds }>;
    /** Panel-authored art, passed through to `Welcome.visuals`. */
    visuals?: RenderManifest;
    /** Game-hosted `ServerScript` classes, forwarded to `loadGame`. */
    gameScripts?: GameManifest['gameScripts'];
    /** What every spawn key means, from `toGameManifest(validate(file), …)`. */
    templates?: GameManifest['templates'];
    /** The placed world, parents before children — instantiated before the first `accept`. */
    entities?: GameManifest['entities'];
    /** Names a script class on the wire; without it no `attach` op is journaled at all, since the op names an id. */
    scripts?: ScriptIndex;
    /** What this build is. Omitted, every joiner declaring nothing is admitted and nothing else. */
    project?: ProjectIdentity;
    /** Where `@serverState` outlives a session. Omitted, core's `MemoryKVStore` stands in and dies with the process. */
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
    /** Where this server's own denials and core's diagnostics go; without one an operator has no record of why a session died. */
    log?: LogSink;
    /** Called when the breaker disables a script's handler or callback — the dev channel, deliberately not an envelope. */
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
    /** Structural ops over this send's budget, kept in order for the next one — the only server state that survives a send set. */
    readonly #spill: WireStructuralOp[] = [];
    readonly #started: Promise<void>;
    /** `@serverState` that outlives a session — read synchronously, written through at a leave. */
    readonly #persisted: PersistedState;
    /** Store writes still in flight, so a shutdown can wait for the ones it just started. */
    readonly #saves = new Set<Promise<unknown>>();

    /** What `close()` hands back, so a second caller waits on the first call's drain rather than on nothing. */
    #drain: Promise<void> = Promise.resolve();
    #nextConnectionId = 1;
    /** Marks and ops dropped as unrepresentable, cumulative. */
    #dropped = 0;
    /** Marks whose host died before the send that would have carried them, cumulative. */
    #stale = 0;
    #closed = false;
    /** False until the world exists; `accept` refuses while it is. */
    #booted = false;

    constructor(opts: GameServerOptions = {}) {
        const config = opts.config ?? {};
        this.#config = resolveConfig(config);
        if (!Number.isInteger(this.#config.maxPlayers) || this.#config.maxPlayers < 1) {
            throw new ServerError(
                'invalid-config',
                `maxPlayers must be a positive integer, received ${this.#config.maxPlayers}`,
            );
        }
        this.#codec = opts.codec ?? jsonCodec;

        // Built ahead of `loadGame`, because it is the only thing that checks the two rates and a bad
        // rate must refuse before a world is built rather than after.
        this.#driver = new Driver(
            { stepOnce: () => this.#stepOnce(), send: () => this.#send() },
            {
                simRate: this.#config.simRate,
                sendRate: this.#config.sendRate,
                ...defined({ deliver: opts.deliver, timer: opts.timer, now: opts.now }),
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
                ...defined({ log: opts.log }),
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
        this.#persisted = new PersistedState(this.#rt.kv);
        this.#rt.persisted = this.#persisted;

        // Registered before `startGame` below, so a Game `@onStart` that trips the breaker on its
        // very first tick is still reported.
        if (opts.onBreakerTrip !== undefined) this.#rt.dispatcher.onTrip(opts.onBreakerTrip);

        // Installed before the first step, so no tick ever runs against core's stub.
        const passes = this.#rt.passes;
        if (passes === undefined) {
            throw new ServerError(
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
                        connections: () => this.#connections.values(),
                    },
                    dispatch,
                ),
        };

        // Not awaited: a start handler awaiting a timer cannot complete until the loop steps, so
        // awaiting this would deadlock the server against its own driver.
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

    /** Live connections in accept order. */
    get connections(): Connection[] {
        return [...this.#connections.values()];
    }

    /** How many wakes hit the step cap with backlog left and shed it — the sim falling behind, and the only number that measures it. */
    get shedCount(): number {
        return this.#driver.shedCount;
    }

    /** Whether the world is built, and so whether `accept` will admit anything. */
    get booted(): boolean {
        return this.#booted;
    }

    /** Registers one established connection and returns its id, or `null` if it was refused and closed. */
    accept(transport: Transport, playerId?: string): string | null {
        if (playerId !== undefined && playerId === '') {
            throw new ServerError(
                'invalid-argument',
                'playerId must be a non-empty string, or omitted',
            );
        }
        const refusal = this.#acceptRefusal(playerId);
        if (refusal !== null) {
            // No connection id: one is minted for a socket this server keeps, and an id in a log
            // line for a socket it just closed is an id a reader will go looking for.
            this.#rt.log.warn(`accept-refused reason=${refusal}`);
            transport.close();
            return null;
        }

        const connectionId = `c${this.#nextConnectionId++}`;
        const conn = new Connection(
            connectionId,
            playerId ?? null,
            transport,
            this.#driver.hasReading ? this.#driver.elapsedSeconds : null,
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
        this.#sweepJoinDeadline(this.#driver.elapsedSeconds);
        return result;
    }

    /** Networked: self-drive off the injected timer. */
    start(): void {
        if (this.#closed) {
            throw new ServerError('server-closed', 'GameServer is closed and cannot be started');
        }
        this.#driver.start();
    }

    /** Stops the driver, leaving every connection open — `close()` is the shutdown. */
    stop(): void {
        this.#driver.stop();
    }

    /** Shuts the server down: stops the driver, closes every connection, and settles once every departing player's save has landed. Idempotent. */
    close(): Promise<void> {
        if (this.#closed) return this.#drain;
        this.#closed = true;
        this.#driver.stop();
        // Deleting the entry the iterator has already yielded is well-defined, which is what lets the
        // close path run inline here rather than over a snapshot.
        for (const conn of this.#connections.values()) {
            conn.transport.close();
            this.#onTransportClosed(conn);
        }
        // `allSettled`, so a store that rejects releases the drain rather than holding the shutdown
        // open forever on the one write that will never land.
        this.#drain = Promise.allSettled(this.#saves).then(() => undefined);
        return this.#drain;
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

    /** A send-tick: drain the three channels once, fan them out, then answer any pending join. */
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
        this.#stale += set.staleMarks;

        // Ahead of the fan-out, never after: this send's journal may spawn the first entity of a
        // template these peers have not been told about, and a node created against a table that
        // does not hold it yet draws the placeholder and keeps it.
        const additions = this.#visuals.drain();

        for (const conn of this.#connections.values()) {
            try {
                this.#sendTo(conn, set, additions);
            } catch (error) {
                // Per connection: without it one peer whose encode throws takes the broadcast down
                // for every peer behind it in the registry.
                this.#deny('close', conn, 'send-failed', errorMessage(error));
                conn.transport.close();
            }
        }
    }

    /** One connection's share of a send: the broadcast, or the `Welcome` it is still owed. */
    #sendTo(conn: Connection, set: SendSet, additions: RenderManifest | null): void {
        if (conn.wantsBroadcast) {
            if (additions !== null) {
                send(conn.transport, { kind: 'manifest', visuals: additions });
            }
            broadcastTo(conn, set, this.#codec);
            return;
        }
        const pending = conn.pendingJoin;
        const player = conn.livePlayer;
        if (pending === null || player === null) return;
        conn.structuralSkip = this.#spill.length;
        this.#sendWelcome(conn, this.#welcome(player, pending));
        // Cleared only once the `Welcome` is on the wire: cleared first, a throw above would leave
        // this connection reading as broadcast-ready with no baseline behind it.
        conn.pendingJoin = null;
    }

    /** Sends a `Welcome`, split across `snapshot-chunk` frames when the world is too big for one. */
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

    /** Narrows one inbound frame; a frame it cannot name is ignored and the connection survives. */
    #receive(conn: Connection, message: Message): void {
        if (conn.closed) return;
        const envelope = asClientEnvelope(message);
        if (envelope === undefined) return;
        const onInputBucket =
            envelope.kind === 'input' ||
            envelope.kind === 'interaction' ||
            envelope.kind === 'request';
        if (!onInputBucket && !conn.admission.takeControlToken()) return;
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
            case 'request':
                this.#request(conn, envelope);
                return;
            case 'time-sync':
                this.#timeSync(conn, envelope);
                return;
        }
    }

    /** The join sequence, in the order the checks must run: version, identity, then — once the persisted record is cached — capacity. */
    #join(conn: Connection, request: JoinRequest): void {
        if (conn.joined) {
            if (request.protocolVersion !== PROTOCOL_VERSION) this.#reject(conn, 'version');
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
        if (conn.admitting) return;

        if (conn.identity !== null && !this.#persisted.has(playerKey(conn.playerId))) {
            conn.admitting = true;
            void this.#persisted
                .load(playerKey(conn.playerId))
                // Admitted anyway, seeded with nothing: a store that cannot be read is a degraded
                // session rather than a refused one, and the cache stays empty for this host — which
                // is what stops the leave writing this session's initializers over the unread save.
                .catch((error: unknown) => {
                    this.#rt.log.warn(`reading ${conn.playerId} failed: ${errorMessage(error)}`);
                })
                .then(() => {
                    conn.admitting = false;
                    this.#admit(conn, request);
                })
                .catch((error: unknown) => {
                    conn.admitting = false;
                    this.#rt.log.warn(`admitting ${conn.playerId} failed: ${errorMessage(error)}`);
                });
            return;
        }
        this.#admit(conn, request);
    }

    /** Allocates the Player, once this connection's persisted record is in the cache. */
    #admit(conn: Connection, request: JoinRequest): void {
        if (conn.closed || this.#closed || conn.joined) return;

        // Tested here rather than at the request: an identified join waits on the persisted read and
        // the roster can fill while it does.
        const roster = this.#rt.playerManager?.players.length ?? 0;
        if (roster >= this.#config.maxPlayers) {
            this.#reject(conn, 'full');
            return;
        }
        // Two live connections under one id share a host record, and the second to leave would write
        // its own values over the first's.
        if ((this.#rt.playerManager?.byId(conn.playerId) ?? null) !== null) {
            this.#rt.log.warn(`refusing a second connection claiming ${conn.playerId}`);
            this.#reject(conn, 'full');
            return;
        }

        const player = joinPlayer(this.#rt, conn.playerId, sanitizeName(request.name));
        conn.player = player;
        conn.admission.noteTraffic(this.#rt.tick);
        conn.pendingJoin = request;

        // Queued rather than sent, so the next broadcast prepends it ahead of the spawns the join
        // handler just produced.
        this.#roster.joins.push(readPlayerSnapshot(player));
    }

    /** Whether a joiner is running what this server is running; a `bundleHash` of `''` is the one legal asymmetry. */
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
        this.#deny('reject', conn, reason);
        const reject: Reject = { kind: 'reject', reason, serverProtocolVersion: PROTOCOL_VERSION };
        send(conn.transport, reject);
        conn.transport.close();
    }

    /** One line per denial, in `key=value` tokens an operator greps for; any prose comes last. */
    #deny(event: string, conn: Connection, reason: string, detail?: string): void {
        const tail = detail === undefined ? '' : `: ${detail}`;
        this.#rt.log.warn(`${event} conn=${conn.connectionId} reason=${reason}${tail}`);
    }

    #input(conn: Connection, frame: InputFrame): void {
        if (!conn.joined) return;
        const result = this.#buffer.admit(conn, frame, this.#rt.tick, this.#rt.simRate);

        if (
            result.kind === 'refused' &&
            result.reason === 'rate' &&
            conn.admission.overRateBreachLimit
        ) {
            this.#deny('close', conn, 'rate-breach');
            conn.transport.close();
        }
    }

    /** Queues a frame's interactions for the tick pass, which is where they are dispatched. */
    #interaction(conn: Connection, frame: InteractionFrame): void {
        if (!conn.joined || !this.#takeInputToken(conn)) return;
        for (const event of frame.events) conn.interactions.push(event);
    }

    /** Queues a frame's requests for the tick pass, which is where the authority answers them. */
    #request(conn: Connection, frame: RequestFrame): void {
        if (!conn.joined || !this.#takeInputToken(conn)) return;
        for (const call of frame.requests) conn.requests.push(call);
    }

    /** Spends an input token for a frame the bucket meters, closing a connection that has sustained a breach. */
    #takeInputToken(conn: Connection): boolean {
        if (conn.admission.takeToken()) return true;
        if (conn.admission.overRateBreachLimit) {
            this.#deny('close', conn, 'rate-breach');
            conn.transport.close();
        }
        return false;
    }

    #timeSync(conn: Connection, sync: TimeSync): void {
        send(conn.transport, {
            kind: 'time-sync-reply',
            clientSentMs: sync.clientSentMs,
            serverSentMs: this.#driver.nowSeconds * 1000,
            serverTick: this.#rt.tick,
        });
    }

    /** The per-connection close path: drop it from the registry, run the disposers, then release the player. */
    #onTransportClosed(conn: Connection): void {
        if (conn.closed) return;
        conn.closed = true;
        this.#connections.delete(conn.connectionId);
        this.#buffer.dropConnection(conn);
        conn.dispose();

        const player = conn.player;
        if (player === null) return;
        conn.player = null;

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
        if (record !== undefined && conn.identity !== null && this.#persisted.has(record.hostId)) {
            this.#persist(record);
        }
        this.#roster.leaves.push(player.id);
    }

    /** Writes a departing player's `@serverState` through to the store; the caller is a socket that has already closed, so only `close()` ever waits on one. */
    #persist(record: HostRecord): void {
        const save = this.#persisted.save(record).catch((error: unknown) => {
            this.#rt.log.warn(`persisting ${record.hostId} failed: ${errorMessage(error)}`);
        });
        this.#saves.add(save);
        // Dropped once it settles, so a long session is not sized by every player it ever saw.
        void save.finally(() => this.#saves.delete(save));
    }

    /** Why this socket may not be registered, or null to admit it. */
    #acceptRefusal(playerId: string | undefined): string | null {
        if (!this.#booted) return 'not-booted';
        if (this.#closed) return 'server-closed';
        let unjoined = 0;
        let claimed = false;
        for (const conn of this.#connections.values()) {
            if (conn.joined) continue;
            unjoined += 1;
            if (conn.identity === playerId) claimed = true;
        }
        if (unjoined >= MAX_UNJOINED_CONNECTIONS) return 'unjoined-cap';
        // One pre-join slot per named peer: the cap above is a total, so without this a single peer
        // reconnect-looping holds every slot and locks out everyone else at no cost to itself.
        return playerId !== undefined && claimed ? 'identity-pending' : null;
    }

    /** Closes a connection that has not joined inside the deadline — the one denial needing no frame at all. */
    #sweepJoinDeadline(elapsedSeconds: number): void {
        const deadline = JOIN_DEADLINE_MS / 1000;
        // Collected, then closed: `close()` never fires its handler synchronously, but a sweep that
        // mutated the registry mid-iteration would be relying on that rather than stating it.
        const expired: Connection[] = [];
        for (const conn of this.#connections.values()) {
            if (conn.joined || conn.closed) continue;
            if (conn.acceptedAtSeconds === null) {
                conn.acceptedAtSeconds = elapsedSeconds;
                continue;
            }
            if (elapsedSeconds - conn.acceptedAtSeconds >= deadline) expired.push(conn);
        }
        for (const conn of expired) {
            this.#deny('close', conn, 'join-deadline');
            conn.transport.close();
        }
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

/** The message of an unknown throwable, since a `catch` binding is not an `Error`. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

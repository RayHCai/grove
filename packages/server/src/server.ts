// GameServer: the connection registry, the join sequence, and the close path.
//
// The transport interface is one end of one connection, and standing up a listener is a factory
// concern — so this is the missing multiplexer, the piece transport declined to hold. The server never
// opens a socket: transports arrive from a loopback pair or a WebSocket listener, and the composition
// root wires the factory's output into `accept`.

import type { Bounds } from '@platform/math';
import type { EngineConfig, GameManifest, Player, Runtime } from '@platform/core';
import { Loop, joinPlayer, leavePlayer, loadGame, resolveConfig, startGame } from '@platform/core';
import type {
    ClientToServer,
    InputAction,
    InputFrame,
    JoinRequest,
    Reject,
    RejectReason,
    RenderManifest,
    TimeSync,
    Welcome,
    WireBounds,
    WireRegion,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import type { Codec, Message, TimerSource, Transport } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import { Connection } from './connection.js';
import type { RosterOps } from './broadcast.js';
import { broadcastTo, drainOnce, readPlayerSnapshot, send } from './broadcast.js';
import {
    JOIN_DEADLINE_MS,
    MAX_ACTIONS_PER_FRAME,
    MAX_ACTION_NAME_LENGTH,
    MAX_NAME_LENGTH,
    MAX_UNJOINED_CONNECTIONS,
    RATE_BREACH_CLOSE,
    assertRate,
    pastGraceTicks,
} from './constants.js';
import { Driver } from './driver.js';
import type { PumpResult } from './driver.js';
import { InputBuffer, runInputPass } from './input.js';
import { buildSnapshot } from './snapshot.js';

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
    readonly #visuals: RenderManifest;
    readonly #buffer = new InputBuffer();
    readonly #driver: Driver;
    /** Roster ops awaiting the next send — core's journal has no arm for either. */
    readonly #roster: RosterOps = { joins: [], leaves: [] };
    readonly #started: Promise<void>;

    #nextConnectionId = 1;
    /** Marks and ops dropped as unrepresentable, cumulative. */
    #dropped = 0;
    #closed = false;

    constructor(opts: GameServerOptions = {}) {
        const config = opts.config ?? {};
        this.#config = resolveConfig(config);
        // `resolveConfig` fills defaults without validating, and the failures are silent: a `simRate`
        // of 0 makes `dt` infinite, so the accumulator never reaches it and the world never steps.
        assertRate('simRate', this.#config.simRate);
        assertRate('sendRate', this.#config.sendRate);
        if (!Number.isInteger(this.#config.maxPlayers) || this.#config.maxPlayers < 1) {
            throw new RangeError(
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
        this.#visuals = config.visuals ?? { assets: [], templates: [] };

        // `role: 'server'` is the location filter: it makes the loop dispatch only server and synced
        // handlers, so client-only scripts are inert here, which is the trust boundary. Every other
        // seam is left at core's null default.
        this.#rt = loadGame({
            role: 'server',
            simRate: this.#config.simRate,
            bounds,
            ...(config.regions === undefined ? {} : { regions: config.regions }),
            ...(config.visuals === undefined
                ? {}
                : { assets: config.visuals.assets.map((a) => assetManifestEntry(a)) }),
            ...(config.gameScripts === undefined ? {} : { gameScripts: config.gameScripts }),
        });
        this.#loop = new Loop(this.#rt);

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

        // Not awaited. This promise settles when every Game start handler completes, and a handler
        // awaiting a timer cannot complete until the loop steps — so awaiting it here deadlocks the
        // server against its own driver. It runs to each handler's first await synchronously, which is
        // the guarantee that matters: world construction that must precede a join belongs before it.
        this.#started = startGame(this.#rt);
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

    /**
     * Registers one established connection and returns its id, or `null` if it was refused and closed.
     *
     * It sends no frame and mutates no roster, because the client speaks first — and handlers are
     * registered before any state mutation, so no frame arriving during join is dropped.
     *
     * The refusal is `null` rather than an id: the unjoined cap is distinct from `maxPlayers` so that
     * unjoined sockets cannot lock out real players, and handing back an id for a socket this call just
     * closed reads at the composition root as a connection that is still live.
     */
    accept(transport: Transport): string | null {
        if (this.#closed || this.#unjoinedCount() >= MAX_UNJOINED_CONNECTIONS) {
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
        const set = drainOnce(this.#rt, this.#rt.tick, this.#roster);
        this.#roster.joins.length = 0;
        this.#roster.leaves.length = 0;
        this.#dropped += set.dropped;

        for (const conn of this.#connections.values()) {
            if (conn.wantsBroadcast) {
                broadcastTo(conn, set, this.#codec);
                continue;
            }
            // Skipped by the broadcast above, because everything in this set predates the snapshot it
            // is about to receive.
            const pending = conn.pendingJoin;
            if (pending === null || conn.closed || conn.player === null) continue;
            conn.pendingJoin = null;
            send(conn.transport, this.#welcome(conn.player, pending));
        }
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
        // covers neither, so they draw on a second and far shallower one.
        if (envelope.kind !== 'input' && !conn.admission.takeControlToken()) return;
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
            case 'time-sync':
                this.#timeSync(conn, envelope);
                return;
        }
    }

    /**
     * The join sequence, in the order the checks must run: version before anything is built, capacity
     * before anything is allocated, and a `Reject` before the close.
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
            else conn.pendingJoin = request;
            return;
        }

        if (request.protocolVersion !== PROTOCOL_VERSION) {
            this.#reject(conn, 'version');
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

    /** Exactly protocol's fields, with `reconnectToken` omitted — the MVP mints none. */
    #welcome(player: Player, request: JoinRequest): Welcome {
        return {
            kind: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            yourPlayerId: player.id,
            yourPlayerIndex: player.index,
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
            visuals: this.#visuals,
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
        leavePlayer(this.#rt, player.id);
        this.#roster.leaves.push(player.id);
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
        case 'time-sync':
            return isTimeSync(message) ? message : undefined;
        default:
            return undefined;
    }
}

function isJoinRequest(message: object): message is JoinRequest {
    const m = message as Partial<JoinRequest>;
    return (
        typeof m.protocolVersion === 'number' &&
        typeof m.name === 'string' &&
        typeof m.clientSentMs === 'number'
    );
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

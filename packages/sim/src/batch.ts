// The whole seam. A host hands the sim one batch per tick and writes what comes back; nothing else
// crosses, which is what lets the host be another language and the same advance run in a browser.

import type { JsonValue } from '@platform/transport';
import type { ServerToClient } from '@platform/protocol';

/** A host-minted id for one established connection, opaque to the sim and stable for its life. */
export type ConnectionId = string;

/** A connection the host has established and authenticated, offered to the sim for this tick. */
export interface OpenedConnection {
    connectionId: ConnectionId;
    /**
     * Who the HOST resolved this peer to be, or null when it resolved nobody.
     *
     * The sim never derives it from a frame: it becomes `player.id`, so it is what persisted
     * `@serverState` is keyed by and what every other peer sees.
     */
    identity: string | null;
}

/** One decoded frame, attributed to the connection it arrived on rather than to anything it claims. */
export interface InboundFrame {
    connectionId: ConnectionId;
    /** Decoded but NOT narrowed: the sim owns the narrowing, since it owns what each field bounds. */
    message: unknown;
}

/** A record the host read back for a {@link LoadOrder}. */
export interface LoadedRecord {
    connectionId: ConnectionId;
    /**
     * The fields the store held — `{}` for a host it holds nothing for, and `null` only when the read
     * FAILED.
     *
     * The two are not the same answer: a store that held nothing is a new player whose state must be
     * saved at the leave, while a store that could not be read is a degraded session whose save this
     * session's initializers must not overwrite.
     */
    fields: { [field: string]: JsonValue } | null;
}

/** One tick's arrivals, and the two facts about the outside world the advance is allowed to know. */
export interface InputBatch {
    /**
     * Host wall-clock in milliseconds, stamped into `Welcome` and `TimeSyncReply` and differenced
     * against nothing — a client compares only its own two stamps.
     */
    nowMs: number;
    /** Whether this tick closes a send interval; the cadence is the host's, counted on its clock. */
    drain: boolean;
    /** Connections accepted since the last tick, in accept order. */
    opened: OpenedConnection[];
    /** Frames that arrived since the last tick, in arrival order across every connection. */
    frames: InboundFrame[];
    /** Connections the host lost or closed since the last tick. */
    closed: ConnectionId[];
    /** Answers to the loads the sim asked for on an earlier tick. */
    records: LoadedRecord[];
    /**
     * Host keys whose {@link SaveOrder} has landed in the store.
     *
     * The sim holds a saved record until this arrives, so a player who leaves and rejoins inside one
     * session reads their own values back without a second round trip; released here, so a long
     * session is not sized by every player it ever saw.
     */
    saved: string[];
}

/** An empty batch — one quiet tick, which is the common case. */
export function idleBatch(nowMs: number, drain = false): InputBatch {
    return { nowMs, drain, opened: [], frames: [], closed: [], records: [], saved: [] };
}

/**
 * One envelope and who receives it, in the order the host must write it.
 *
 * `to` is a list because a transform envelope is byte-identical for every peer, which is the whole
 * of the shared subset and the only thing worth encoding once.
 */
export interface Send {
    to: ConnectionId[];
    envelope: ServerToClient;
    /** Droppable frames are superseded by the next of their kind, so a backed-up host may discard one. */
    class: 'reliable' | 'droppable';
}

/** A connection the sim is finished with, closed after every frame already queued for it. */
export interface CloseOrder {
    connectionId: ConnectionId;
    /** Why, in the same token an operator greps the log for. */
    reason: string;
}

/** A persisted read the sim needs before it can allocate a `Player` for this connection. */
export interface LoadOrder {
    connectionId: ConnectionId;
    /** The host record's key — a `playerKey`, which is what the save is filed under too. */
    hostKey: string;
}

/** A departing player's `@serverState`, written through by the host because only it holds a store. */
export interface SaveOrder {
    hostKey: string;
    fields: { [field: string]: JsonValue };
}

/** One operator line, already in the `event conn=<id> reason=<token>` shape a log is grepped by. */
export interface LogLine {
    level: 'debug' | 'info' | 'warn' | 'error';
    line: string;
}

/** Counters a host reports, cumulative across the session rather than per tick. */
export interface SimDiagnostics {
    /** Marks and ops dropped as unrepresentable. Nonzero is a bug report, not a failure. */
    dropped: number;
    /** Marks whose host died between the write and the send — churn, not a defect. */
    stale: number;
}

/** Everything one tick produced. Empty on a tick that neither drained nor answered anything. */
export interface OutputBatch {
    /** The tick this batch describes — the sim's counter, not the host's. */
    tick: number;
    sends: Send[];
    closes: CloseOrder[];
    loads: LoadOrder[];
    saves: SaveOrder[];
    log: LogLine[];
    diagnostics: SimDiagnostics;
}

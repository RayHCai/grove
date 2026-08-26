// The join sequence and the clock-sync frames.
//
// The client speaks first, which forced the server to allocate its `Player` on the first valid
// `JoinRequest` rather than on `accept()`: the name, a version that can still refuse cleanly, and the
// reconnect token have nowhere else to live. The cost is one round trip.

import type { Message, Transport } from '@platform/transport';
import type {
    ClientToServer,
    JoinRequest,
    ProjectId,
    Reject,
    ServerToClient,
    TimeSync,
    Welcome,
} from '@platform/protocol';
import { PROTOCOL_VERSION } from '@platform/protocol';
import { MAX_SNAPSHOT_CHUNKS, MAX_WIRE_ITEMS } from './constants.js';

/** A monotonic wall-clock in seconds. Injected, never `Date.now()` at a call site. */
export interface ClockSource {
    nowSeconds(): number;
}

/**
 * What this client claims to be running, which the server compares against its own before it
 * allocates a `Player`.
 *
 * All-empty is a real answer, not a missing one: it says "I declare no project", which matches a
 * server that declares none and mismatches one that does.
 */
export interface ClientProject {
    projectId: ProjectId;
    projectHash: string;
    /** The bundle this client has already verified; `''` until it has loaded one. */
    bundleHash: string;
}

/** A client with no project of its own — every field the empty string, never an absent key. */
export function unidentifiedProject(): ClientProject {
    return { projectId: '', projectHash: '', bundleHash: '' };
}

/** Builds the first frame on a connection. `token` is omitted when absent, never `undefined`. */
export function joinRequest(
    name: string,
    clientSentMs: number,
    project: ClientProject = unidentifiedProject(),
    token?: string,
): JoinRequest {
    const request: JoinRequest = {
        kind: 'join-request',
        protocolVersion: PROTOCOL_VERSION,
        name,
        clientSentMs,
        projectId: project.projectId,
        projectHash: project.projectHash,
        bundleHash: project.bundleHash,
    };
    if (token !== undefined) request.token = token;
    return request;
}

export function timeSync(clientSentMs: number): TimeSync {
    return { kind: 'time-sync', clientSentMs };
}

/** Sends a client envelope. Typed at the boundary, so nothing untyped reaches `Transport.send`. */
export function send(transport: Transport, envelope: ClientToServer): void {
    transport.send(envelope as unknown as Message);
}

/**
 * The RTT the lead seeds from, in seconds.
 *
 * Both stamps are the client's own off one clock, so this survives a skewed server clock. The caller passes
 * the stamp it recorded at send, never the peer-controlled echo. Differencing `serverSentMs` against a
 * client stamp instead yields RTT plus an unknown offset, which is how this arithmetic goes wrong.
 */
export function rttSeconds(clientNowMs: number, clientSentMs: number): number {
    const rtt = (clientNowMs - clientSentMs) / 1000;
    return Number.isFinite(rtt) && rtt > 0 ? rtt : 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * An array the client will walk, short enough to walk. `Array.isArray` alone bounds nothing, and the
 * count is peer-chosen — so it is checked before the walk, not during it.
 */
function isBoundedArray(value: unknown): value is unknown[] {
    return Array.isArray(value) && value.length <= MAX_WIRE_ITEMS;
}

function isWireBounds(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const b = value as Record<string, unknown>;
    return (
        isFiniteNumber(b.left) &&
        isFiniteNumber(b.right) &&
        isFiniteNumber(b.top) &&
        isFiniteNumber(b.bottom)
    );
}

/**
 * Narrows an inbound frame to a server envelope, or `undefined`.
 *
 * A type is a compile-time claim and the bytes are a runtime fact, so this checks rather than casts: an
 * exhaustive `kind` test plus the depth-one fields the client dereferences unguarded. Anything deeper is
 * the mirror's drop-and-count, with the drain's catch as backstop — validating a whole snapshot here would
 * duplicate protocol's schema in the hot path.
 *
 * A `welcome` passes on `kind` alone, because an unusable one is terminal where a bad `state` is dropped.
 */
export function asServerEnvelope(message: unknown): ServerToClient | undefined {
    if (typeof message !== 'object' || message === null) return undefined;
    const m = message as Record<string, unknown>;
    switch (m.kind) {
        case 'welcome':
            return message as ServerToClient;
        case 'snapshot-chunk':
            // Both arrays are walked on reassembly, so both are bounded here — and the index, since
            // it is compared against a position the client is counting.
            return isFiniteNumber(m.index) && isBoundedArray(m.entities) && isBoundedArray(m.state)
                ? (message as ServerToClient)
                : undefined;
        case 'reject':
            return isFiniteNumber(m.serverProtocolVersion)
                ? (message as ServerToClient)
                : undefined;
        case 'state':
            return isFiniteNumber(m.tick) &&
                isFiniteNumber(m.ackSeq) &&
                isBoundedArray(m.structural) &&
                isBoundedArray(m.state) &&
                (m.earliestHeadroom === undefined || isFiniteNumber(m.earliestHeadroom))
                ? (message as ServerToClient)
                : undefined;
        case 'transform':
            return isFiniteNumber(m.tick) && isBoundedArray(m.transform)
                ? (message as ServerToClient)
                : undefined;
        case 'manifest': {
            // Both arrays are walked on merge, so both are bounded before the walk. An unusable
            // update is dropped rather than fatal: the cost is a placeholder, not a broken session.
            const visuals = m.visuals as Record<string, unknown> | null | undefined;
            return typeof visuals === 'object' &&
                visuals !== null &&
                isBoundedArray(visuals.assets) &&
                isBoundedArray(visuals.templates)
                ? (message as ServerToClient)
                : undefined;
        }
        case 'time-sync-reply':
            return isFiniteNumber(m.clientSentMs) ? (message as ServerToClient) : undefined;
        case 'rate-change':
            return isFiniteNumber(m.simRate) && m.simRate > 0
                ? (message as ServerToClient)
                : undefined;
        default:
            return undefined;
    }
}

/**
 * True when a `Welcome` is structurally usable.
 *
 * Every field the join path dereferences, because the unguarded ones — `bounds`, `regions`, `visuals`,
 * `snapshot.state` — would otherwise throw out of the frame and end the session with nothing to show.
 * `bundleUrl` and `bundleHash` are here for the sharper reason: the client fetches one and compares
 * against the other, and a non-string either side would compare equal to nothing and fetch nowhere.
 */
export function isUsableWelcome(welcome: Welcome): boolean {
    if (typeof welcome !== 'object' || welcome === null) return false;
    const snapshot = welcome.snapshot as unknown;
    if (typeof snapshot !== 'object' || snapshot === null) return false;
    const s = snapshot as Record<string, unknown>;
    const visuals = welcome.visuals as unknown as Record<string, unknown> | null;

    return (
        typeof welcome.projectId === 'string' &&
        typeof welcome.projectHash === 'string' &&
        typeof welcome.bundleHash === 'string' &&
        typeof welcome.bundleUrl === 'string' &&
        isFiniteNumber(welcome.simRate) &&
        welcome.simRate > 0 &&
        isFiniteNumber(welcome.sendRate) &&
        welcome.sendRate > 0 &&
        typeof welcome.yourPlayerId === 'string' &&
        isWireBounds(welcome.bounds) &&
        isBoundedArray(welcome.regions) &&
        welcome.regions.every((r) => typeof r?.name === 'string' && isWireBounds(r?.bounds)) &&
        typeof visuals === 'object' &&
        visuals !== null &&
        isBoundedArray(visuals.assets) &&
        isBoundedArray(visuals.templates) &&
        isFiniteNumber(s.tick) &&
        isBoundedArray(s.entities) &&
        isBoundedArray(s.players) &&
        isBoundedArray(s.state) &&
        isChunkCount(welcome.snapshotChunks)
    );
}

/**
 * A chunk count the client can hold to: absent, or a whole number within the cap it buffers.
 *
 * Absent is the ordinary case and means the world fitted in one frame. The cap is the receiver's, not
 * the shape's — a count is peer-chosen and every chunk it promises is memory the client holds until
 * the `Welcome` arrives.
 */
function isChunkCount(value: unknown): boolean {
    if (value === undefined) return true;
    return (
        Number.isSafeInteger(value) &&
        (value as number) >= 0 &&
        (value as number) <= MAX_SNAPSHOT_CHUNKS
    );
}

/**
 * How a `Reject` reads to a person — never as a network error, since a version mismatch must not retry.
 *
 * An unrecognized reason is terminal rather than a throw: a client that cannot name it still knows.
 */
export function rejectMessage(reject: Reject): string {
    switch (reject.reason) {
        case 'version':
            return `This game needs an update — the server speaks protocol ${reject.serverProtocolVersion}, this client speaks ${PROTOCOL_VERSION}.`;
        case 'full':
            return 'This game is full.';
        case 'identity':
            // Deliberately does not say which of the three disagreed: the wire keeps the reason
            // coarse, and the answer is the same either way.
            return 'This game has been updated — reload the page to get the current version.';
        default:
            return 'The server refused the connection.';
    }
}

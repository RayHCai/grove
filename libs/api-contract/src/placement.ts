import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { GameId, HostId, InstanceId, PlayerId, SessionId } from './ids.js';

export const PlacementRequest = z.object({
    gameId: GameId,
    playerId: PlayerId,
    /**
     * The version this join is for, which the caller decides and the fleet never guesses.
     * A router ranking over its own boxes has no answer for the first player into a quiet game.
     */
    revision: z.int().positive(),
    /**
     * The code a box starts this session on, carried because the box may have to start one.
     * Every byte behind the urls is content-addressed, so a box fetches once per version.
     */
    bundles: BundleSet,
    /** Left off when the caller has no preference, and the fleet then chooses on load alone. */
    region: z.string().min(1).max(32).optional(),
});
export type PlacementRequest = z.infer<typeof PlacementRequest>;

/**
 * Where @grove/server-manager put a session. It carries no token on purpose: @grove/api adds the
 * ticket it signs, so the secret never leaves the one service that holds it.
 */
export const Placement = z.object({
    hostId: HostId,
    instanceId: InstanceId,
    sessionId: SessionId,
    /** The box's player proxy, `/play/<instanceId>` on its public name: a socket, never a page. */
    serverUrl: z.url({ protocol: /^wss?$/u }),
    /**
     * The version the session actually placed is running. Echoed rather than assumed: a rollout
     * leaves older worlds draining, and a browser on the wrong one is refused at the handshake.
     */
    revision: z.int().positive(),
});
export type Placement = z.infer<typeof Placement>;

/**
 * What @grove/server-manager asks a box to start, once its ranking has chosen that box.
 * The bundles cross as refs, not bytes: a box that fetches them caches by content hash.
 */
export const InstanceStart = z.object({
    instanceId: InstanceId,
    gameId: GameId,
    sessionId: SessionId,
    revision: z.int().positive(),
    bundles: BundleSet,
    /** The world's store bearer, minted by the router so no box holds the key that signs one. */
    storeToken: z.string().min(1),
    /** When that bearer dies, which is when the world must already have ended. */
    storeTokenExpiresAt: z.iso.datetime(),
});
export type InstanceStart = z.infer<typeof InstanceStart>;

export const HostCapacity = z.object({
    runningInstances: z.int().nonnegative(),
    maxInstances: z.int().positive(),
    cpuLoad: z.number().min(0).max(1),
    memoryFreeBytes: z.int().nonnegative(),
});
export type HostCapacity = z.infer<typeof HostCapacity>;

export const InstanceReport = z.object({
    instanceId: InstanceId,
    gameId: GameId,
    sessionId: SessionId,
    state: z.enum(['starting', 'healthy', 'draining', 'unhealthy']),
    players: z.int().nonnegative(),
    uptimeSeconds: z.int().nonnegative(),
    /**
     * The version this world is running, which is what makes a session joinable or not.
     * Reported by the box: after an agent restart only the box knows what each process started on.
     */
    revision: z.int().positive(),
    /**
     * The port the box bound for this process, which is the one a player dials.
     * On the wire rather than assumed, because the kernel picks it and a guess is a closed port.
     */
    port: z.int().min(1).max(65535),
});
export type InstanceReport = z.infer<typeof InstanceReport>;

/** An RFC 1123 hostname with no trailing dot and a non-numeric last label, or an IP literal. */
const PublicHost = z.union([
    z.ipv4(),
    z.ipv6(),
    z
        .string()
        .max(253)
        .regex(
            /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?.)*(?=[A-Za-z0-9-]*[A-Za-z-])[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u,
        ),
]);

/** What one @grove/instance-manager sends upward on its interval, for the whole box at once. */
export const HostHeartbeat = z.object({
    hostId: HostId,
    region: z.string(),
    /** Where this box's agent listens, so the router reaches it without a compiled-in port. */
    agentPort: z.int().min(1).max(65535),
    /** The name players and the router dial; absent only where the beat's source address is it. */
    publicHost: PublicHost.optional(),
    /** Where the player proxy listens, the one port a browser reaches on this box. */
    playerPort: z.int().min(1).max(65535),
    /** Whether both listeners serve TLS, which picks wss/https over ws/http for every url here. */
    tls: z.boolean(),
    /** False while the box cannot start a world, so the router stops choosing it first. */
    ready: z.boolean(),
    capacity: HostCapacity,
    /** Every instance every beat rather than a delta, so a dropped beat is free to recover. */
    instances: z.array(InstanceReport),
    /**
     * Minted when the agent starts and fixed for as long as it runs. A box that died and came back
     * inside the staleness window is otherwise a restart nothing upward can see.
     */
    incarnation: z.uuid(),
    /** The last beat of a deliberate shutdown: a crash also goes silent, and is an incident. */
    leaving: z.boolean().optional(),
    reportedAt: z.iso.datetime(),
});
export type HostHeartbeat = z.infer<typeof HostHeartbeat>;

/**
 * What became of a box, as the router concluded rather than as the box claimed.
 * `left` and `failed` are both silence; the difference is whether the box said goodbye first.
 */
export const HostLiveness = z.enum(['healthy', 'suspected', 'left', 'failed']);
export type HostLiveness = z.infer<typeof HostLiveness>;

/** One row of the fleet as the router sees it: liveness follows `lastSeenAt`, never a claim. */
export const HostView = z.object({
    hostId: HostId,
    region: z.string(),
    capacity: HostCapacity,
    lastSeenAt: z.iso.datetime(),
    liveness: HostLiveness,
    incarnation: z.uuid(),
});
export type HostView = z.infer<typeof HostView>;

/** The transition one row of fleet history records. */
export const FleetEventKind = z.enum([
    'registered',
    'restarted',
    'suspected',
    'left',
    'failed',
    'returned',
]);
export type FleetEventKind = z.infer<typeof FleetEventKind>;

/**
 * One transition a box made, which is the only thing about a box worth keeping: the state it is in
 * now arrives on its next beat, and the state it was in arrives on no beat at all.
 */
export const FleetEvent = z.object({
    /**
     * Minted by the router, so a report retried after a failed write lands on the row it already
     * wrote rather than a second copy of it.
     */
    eventId: z.uuid(),
    hostId: HostId,
    region: z.string(),
    kind: FleetEventKind,
    /** The incarnation the box ran, so a restart's events do not read as the last life's. */
    incarnation: z.uuid(),
    at: z.iso.datetime(),
    /** Why, where the kind alone does not say it: the signal a suspicion came from, say. */
    detail: z.string().max(512).optional(),
});
export type FleetEvent = z.infer<typeof FleetEvent>;

/**
 * What @grove/server-manager tells this service about the fleet: the whole fleet every report
 * rather than a delta, so a receiver that missed one is never left describing a fleet as it was.
 */
export const FleetReport = z.object({
    hosts: z.array(HostView),
    /** Transitions since the last report that was acknowledged, retried until one lands. */
    events: z.array(FleetEvent),
    reportedAt: z.iso.datetime(),
});
export type FleetReport = z.infer<typeof FleetReport>;

export const DeploymentRequest = z.object({
    gameId: GameId,
    /** The version replacing the rest, so a world already on it is left running. */
    revision: z.int().positive(),
    /** Both sides in one request, so the code a session runs is one decision rather than two. */
    bundles: BundleSet,
    /** Empty is the whole fleet; naming regions is what makes a rollout staged. */
    regions: z.array(z.string()),
});
export type DeploymentRequest = z.infer<typeof DeploymentRequest>;

/**
 * One box's answer, and one row of the report the fan-out returns. The same shape on both sides,
 * because @grove/server-manager forwards a redeploy and decides nothing about it.
 */
export const HostDeployment = z.object({
    hostId: HostId,
    /** The worlds the version reached, as the box named them. Never empty on `draining`. */
    instanceIds: z.array(InstanceId),
    /** `failed` is the router's own verdict: a box cannot report itself unreachable. */
    status: z.enum(['draining', 'skipped', 'failed']),
    /**
     * Carried verbatim rather than mapped to a code: an operator acting on this needs to read
     * "connection refused" apart from "the agent answered 404", and a code collapses the two.
     */
    error: z.string().optional(),
});
export type HostDeployment = z.infer<typeof HostDeployment>;

export const Deployment = z.object({
    gameId: GameId,
    bundles: BundleSet,
    /**
     * One row per box the version reached, ordered by `hostId` so two identical pushes agree.
     * Fewer than the fleet is a staged rollout; a box holding no world of this game has no row.
     */
    hosts: z.array(HostDeployment),
    deployedAt: z.iso.datetime(),
});
export type Deployment = z.infer<typeof Deployment>;

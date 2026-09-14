import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { GameId, HostId, InstanceId, PlayerId, SessionId } from './ids.js';

export const PlacementRequest = z.object({
    gameId: GameId,
    playerId: PlayerId,
    /** Left off when the caller has no preference, and the fleet then chooses on load alone. */
    region: z.string().min(1).max(32).optional(),
});
export type PlacementRequest = z.infer<typeof PlacementRequest>;

/**
 * Where @grove/server-manager put a session.
 *
 * It carries no token on purpose. @grove/api adds the ticket it signs to make this a `PlaySession`,
 * so the secret a browser's credential is minted with never leaves the one service that holds it.
 */
export const Placement = z.object({
    hostId: HostId,
    instanceId: InstanceId,
    sessionId: SessionId,
    serverUrl: z.url(),
});
export type Placement = z.infer<typeof Placement>;

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
     * The port the box bound for this process, which is the one a player dials.
     *
     * On the wire rather than assumed, because the kernel picks it: without it the router can only
     * guess an address, and every guess is a port the security group does not open.
     */
    port: z.int().min(1).max(65535),
});
export type InstanceReport = z.infer<typeof InstanceReport>;

/** What one @grove/instance-manager sends upward on its interval, for the whole box at once. */
export const HostHeartbeat = z.object({
    hostId: HostId,
    region: z.string(),
    /** Where this box's agent listens, so the router reaches it without a compiled-in port. */
    agentPort: z.int().min(1).max(65535),
    capacity: HostCapacity,
    /** Every instance every beat rather than a delta, so a dropped beat costs nothing to recover. */
    instances: z.array(InstanceReport),
    reportedAt: z.iso.datetime(),
});
export type HostHeartbeat = z.infer<typeof HostHeartbeat>;

/** One row of the fleet as the router sees it — `healthy` follows `lastSeenAt`, never a claim. */
export const HostView = z.object({
    hostId: HostId,
    region: z.string(),
    capacity: HostCapacity,
    lastSeenAt: z.iso.datetime(),
    healthy: z.boolean(),
});
export type HostView = z.infer<typeof HostView>;

export const DeploymentRequest = z.object({
    gameId: GameId,
    /** Both sides in one request, so the code a session runs is one decision rather than two. */
    bundles: BundleSet,
    /** Empty is the whole fleet; naming regions is what makes a rollout staged. */
    regions: z.array(z.string()),
});
export type DeploymentRequest = z.infer<typeof DeploymentRequest>;

export const Deployment = z.object({
    gameId: GameId,
    bundles: BundleSet,
    /**
     * The healthy boxes in the requested regions, which are the ones this version is for.
     *
     * Fewer than the fleet is a staged rollout, not a failure.
     */
    hosts: z.array(HostId),
    deployedAt: z.iso.datetime(),
});
export type Deployment = z.infer<typeof Deployment>;

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
});
export type InstanceReport = z.infer<typeof InstanceReport>;

/** What one @grove/instance-manager sends upward on its interval, for the whole box at once. */
export const HostHeartbeat = z.object({
    hostId: HostId,
    region: z.string(),
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
    /** The whole set, so a host pulls the code from these urls without a second lookup. */
    bundles: BundleSet,
    /** Empty is the whole fleet; naming regions is what makes a rollout staged. */
    regions: z.array(z.string()),
});
export type DeploymentRequest = z.infer<typeof DeploymentRequest>;

export const Deployment = z.object({
    gameId: GameId,
    bundles: BundleSet,
    /** The hosts that took the version. Fewer than the fleet is a staged rollout, not a failure. */
    hosts: z.array(HostId),
    deployedAt: z.iso.datetime(),
});
export type Deployment = z.infer<typeof Deployment>;

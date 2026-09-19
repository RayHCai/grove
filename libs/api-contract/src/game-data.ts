import { z } from 'zod';
import { ContentHash, PlayerId } from './ids.js';

/** A `@serverState` value, as it crosses between a game process and its store. */
export const StateValue = z.json();
export type StateValue = z.infer<typeof StateValue>;

export const StateKeyParams = z.object({ key: z.string().min(1).max(256) });
export type StateKeyParams = z.infer<typeof StateKeyParams>;

export const StateRecord = z.object({
    key: z.string(),
    value: StateValue,
    revision: z.int().nonnegative(),
});
export type StateRecord = z.infer<typeof StateRecord>;

export const StateWrite = z.object({
    value: StateValue,
    /** The revision the writer last read, so a lost update is a 409 rather than silent. */
    ifRevision: z.int().nonnegative().optional(),
});
export type StateWrite = z.infer<typeof StateWrite>;

export const LeaderboardQuery = z.object({
    board: z.string().min(1).max(64),
    /**
     * Clamped rather than refused: a caller asking for more rows than a page holds wants the page,
     * and paging is what the cursor is for.
     */
    limit: z.coerce
        .number()
        .int()
        .transform((value) => Math.min(Math.max(value, 1), 100))
        .default(25),
    cursor: z.string().optional(),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>;

export const LeaderboardEntry = z.object({
    playerId: PlayerId,
    displayName: z.string(),
    score: z.number(),
    rank: z.int().positive(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

/** One player's standing, as a game process submits it. No rank: that is a position in a board. */
export const LeaderboardWrite = z.object({
    board: z.string().min(1).max(64),
    playerId: PlayerId,
    displayName: z.string().min(1).max(64),
    score: z.number().finite(),
});
export type LeaderboardWrite = z.infer<typeof LeaderboardWrite>;

export const LeaderboardPage = z.object({
    board: z.string(),
    entries: z.array(LeaderboardEntry),
    nextCursor: z.string().nullable(),
});
export type LeaderboardPage = z.infer<typeof LeaderboardPage>;

/** Where a session fetches the code every peer must be running. */
export const BundleRef = z.object({
    side: z.enum(['server', 'client']),
    hash: ContentHash,
    url: z.url(),
    byteLength: z.int().positive(),
});
export type BundleRef = z.infer<typeof BundleRef>;

/**
 * Where a session fetches the `SimConfig` its world boots with — beside the code, never configured
 * on a box: a box supplying its own would step one game's world at another's rate.
 */
export const ConfigRef = z.object({
    hash: ContentHash,
    url: z.url(),
    byteLength: z.int().positive(),
});
export type ConfigRef = z.infer<typeof ConfigRef>;

export const BundleSet = z.object({
    server: BundleRef,
    client: BundleRef,
    simConfig: ConfigRef,
    /** Compared at the handshake: prediction is unsound exactly when the two ends differ here. */
    syncedHash: ContentHash,
});
export type BundleSet = z.infer<typeof BundleSet>;

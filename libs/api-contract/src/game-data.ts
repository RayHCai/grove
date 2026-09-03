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
    limit: z.coerce.number().int().min(1).max(100).default(25),
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

export const BundleSet = z.object({
    server: BundleRef,
    client: BundleRef,
    /** Compared at the handshake: prediction is unsound exactly when the two ends differ here. */
    syncedHash: ContentHash,
});
export type BundleSet = z.infer<typeof BundleSet>;

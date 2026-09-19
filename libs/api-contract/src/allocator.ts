import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { GameId, SessionId } from './ids.js';

export const PlayRequestParams = z.object({ gameId: GameId });
export type PlayRequestParams = z.infer<typeof PlayRequestParams>;

/**
 * What a browser is handed to reach a game process. The ticket is scoped to one player in one
 * session and expires on its own, which is why it, and never a platform session, crosses over.
 */
export const PlaySession = z.object({
    sessionId: SessionId,
    serverUrl: z.url(),
    ticket: z.string().min(1),
    expiresAt: z.iso.datetime(),
    /** The version the placed session is on, which is not always the newest one built. */
    revision: z.int().positive(),
    /**
     * The code that session is running, so the browser fetches the half it needs, not the newest.
     * A client on another version is refused at the handshake, or admitted with no scripts at all.
     */
    bundles: BundleSet,
});

export type PlaySession = z.infer<typeof PlaySession>;

/**
 * The join as the player origin reads it: a `PlaySession` and the game it belongs to.
 * It crosses in the url FRAGMENT, never the query, so the ticket stays out of access logs.
 */
export const PlayHandoff = z.object({ gameId: GameId, session: PlaySession });
export type PlayHandoff = z.infer<typeof PlayHandoff>;

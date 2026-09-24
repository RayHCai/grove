import { z } from 'zod';
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
     * What the browser has to claim to be admitted, which it cannot learn from the world it is
     * trying to get into: the authority compares these before it allocates a `Player`, and only
     * the bundle hash has an empty-string escape.
     *
     * No bundle refs beside them, deliberately. What code to run is the `Welcome`'s to say — it
     * names a url and a hash, and the client fetches and verifies that. A second copy here would
     * be this service's guess at what the world a player actually landed in is running.
     */
    projectId: z.string().min(1).max(128),
    projectHash: z.string().min(1).max(128),
});

export type PlaySession = z.infer<typeof PlaySession>;

/**
 * The join as the player origin reads it: a `PlaySession` and the game it belongs to.
 * It crosses in the url FRAGMENT, never the query, so the ticket stays out of access logs.
 */
export const PlayHandoff = z.object({ gameId: GameId, session: PlaySession });
export type PlayHandoff = z.infer<typeof PlayHandoff>;

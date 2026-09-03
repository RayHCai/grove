import { z } from 'zod';
import { GameId, SessionId } from './ids.js';

export const PlayRequestParams = z.object({ gameId: GameId });
export type PlayRequestParams = z.infer<typeof PlayRequestParams>;

/**
 * What a browser is handed to reach a game process.
 *
 * The ticket is scoped to one player in one session and expires on its own, so the page that holds
 * it can do nothing else with it — which is why it, and never a platform session, crosses to the
 * player origin.
 */
export const PlaySession = z.object({
    sessionId: SessionId,
    serverUrl: z.url(),
    ticket: z.string().min(1),
    expiresAt: z.iso.datetime(),
});

export type PlaySession = z.infer<typeof PlaySession>;

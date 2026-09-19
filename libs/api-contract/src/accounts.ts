import { z } from 'zod';
import { GameId, PlayerId } from './ids.js';

/**
 * Who the caller is, and the token their next write has to carry.
 *
 * What every route that mints a session answers with — signing up, signing in, and asking the
 * service for another token while still holding the cookie.
 */
export const SignedIn = z.object({ playerId: PlayerId, csrfToken: z.string() });
export type SignedIn = z.infer<typeof SignedIn>;

/** An account as its holder sees it. Nobody else is ever shown the address. */
export const Account = z.object({
    playerId: PlayerId,
    email: z.email(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
});
export type Account = z.infer<typeof Account>;

/** An account as anyone else sees it: a name to render, and the id it belongs to. */
export const Profile = z.object({ playerId: PlayerId, displayName: z.string() });
export type Profile = z.infer<typeof Profile>;

/**
 * Who may reach a game, which is a fact about the game rather than about any one session.
 *
 * `private` is what a game is created as: a world nobody has finished must not become playable by
 * the act of compiling successfully. `unlisted` is reachable by anybody holding the id and absent
 * from every listing, which is the whole of what a share link is.
 */
export const GameVisibility = z.enum(['private', 'unlisted', 'public']);
export type GameVisibility = z.infer<typeof GameVisibility>;

export const Game = z.object({
    gameId: GameId,
    ownerId: PlayerId,
    title: z.string(),
    visibility: GameVisibility,
    createdAt: z.iso.datetime(),
});
export type Game = z.infer<typeof Game>;

/** What a creator may change about a game once it exists. An absent member is left as it stands. */
export const GameUpdate = z.object({ visibility: GameVisibility.optional() });
export type GameUpdate = z.infer<typeof GameUpdate>;

import type { GameId, PlayerId } from '@grove/api-contract';

/**
 * The durable answers a route needs before a handler runs: which account a credential names, and
 * who owns a game.
 *
 * Handed to `buildApp` rather than imported by a route, so the store behind them is one dependency
 * of the service instead of a handle each module reaches for.
 */
export interface Records {
    signIn(email: string, password: string): Promise<PlayerId | undefined>;
    ownerOf(game: GameId): Promise<PlayerId | undefined>;
}

/** The records seam with nothing behind it: the accounts and projects tables land here. */
export const unattachedRecords: Records = {
    // Answering nothing rather than throwing: with no store attached nobody holds an account and
    // nobody owns a game, which is what the routes already turn into a 401 and a 403.
    signIn: async () => undefined,
    ownerOf: async () => undefined,
};

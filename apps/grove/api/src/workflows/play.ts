import type { KeyObject } from 'node:crypto';
import type { GameId, PlayerId, PlaySession } from '@grove/api-contract';
import { signTicket, ticketId } from '@grove/api-contract/tokens';
import type { Fleet } from '../fleet.js';
import type { Games, Tasks } from '../records.js';

/** Short: a join that outlives its ticket asks again, and a leaked one is spent in a minute. */
export const TICKET_LIFETIME_SECONDS = 60;

export interface PlayDeps {
    games: Pick<Games, 'gameOf'>;
    tasks: Pick<Tasks, 'playableVersionOf'>;
    fleet: Pick<Fleet, 'place'>;
    signingKey: KeyObject;
}

export type Played =
    | { outcome: 'placed'; session: PlaySession }
    | { outcome: 'hidden' }
    | { outcome: 'unbuilt' }
    | { outcome: 'full' };

/** Places a player on the newest version that finished building, and signs the ticket in. */
export async function play(
    deps: PlayDeps,
    game: GameId,
    viewer: PlayerId,
    requestId: string,
): Promise<Played> {
    const found = await deps.games.gameOf(game);
    // Somebody else's private game is answered as a missing one, so a guessed id learns nothing.
    if (found === undefined || (found.visibility === 'private' && found.ownerId !== viewer)) {
        return { outcome: 'hidden' };
    }

    // The newest build that finished, never the newest publish, which may not compile.
    const version = await deps.tasks.playableVersionOf(game);
    if (version === undefined) return { outcome: 'unbuilt' };

    const placement = await deps.fleet.place(game, viewer, version, requestId);
    if (placement === undefined) return { outcome: 'full' };

    const exp = Math.floor(Date.now() / 1000) + TICKET_LIFETIME_SECONDS;
    return {
        outcome: 'placed',
        session: {
            sessionId: placement.sessionId,
            serverUrl: placement.serverUrl,
            // From the cookie, not the request: the game host makes it every peer's `player.id`.
            ticket: signTicket(
                {
                    gameId: game,
                    sessionId: placement.sessionId,
                    playerId: viewer,
                    aud: 'game-instance',
                    exp,
                    jti: ticketId(),
                },
                deps.signingKey,
            ),
            expiresAt: new Date(exp * 1000).toISOString(),
            // What the placed world runs, which a draining world need not share with the newest.
            revision: placement.revision,
            projectId: version.projectId,
            projectHash: version.projectHash,
        },
    };
}

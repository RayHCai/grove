import {
    Placement,
    REQUEST_ID_HEADER,
    type GameId,
    type PlacementRequest,
    type PlayerId,
    type SessionId,
} from '@grove/api-contract';
import type { Env } from './env.js';

/**
 * Where a joining player is sent, which is the one question the allocator cannot answer itself.
 *
 * Handed to `buildApp` the way `Records` is, so the router behind it is one dependency of the
 * service rather than a URL the hot path into a game reaches for.
 */
export interface Fleet {
    place(
        game: GameId,
        player: PlayerId,
        // Passed rather than read off a request, because this seam holds no Fastify types — and a
        // placement the router logged under an id of its own is one no join can be traced into.
        requestId: string,
    ): Promise<{ sessionId: SessionId; serverUrl: string } | undefined>;
}

/** The fleet seam with nothing behind it: @grove/server-manager lands here. */
export const unattachedFleet: Fleet = {
    // Answering nothing rather than throwing: with no router attached there is no box to put a
    // session on, which is what the allocator already turns into a 409.
    place: async () => undefined,
};

/** Two seconds, because this service is one replica and every join waits behind this call. */
const PLACEMENT_TIMEOUT_MS = 2_000;

/** The fleet router over HTTP, behind the shared bearer its `/v1` gate compares. */
export function httpFleet(env: Env): Fleet {
    return {
        place: async (game, player, requestId) => {
            const response = await fetch(`${env.SERVER_MANAGER_URL}/v1/placements`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${env.FLEET_SECRET}`,
                    [REQUEST_ID_HEADER]: requestId,
                },
                body: JSON.stringify({ gameId: game, playerId: player } satisfies PlacementRequest),
                signal: AbortSignal.timeout(PLACEMENT_TIMEOUT_MS),
            });

            if (response.status === 409) return undefined;
            // Anything else is this fleet failing rather than being full, and returning nothing here
            // would hand a player "no capacity" for a router that is simply down.
            if (!response.ok) throw new Error(`server-manager answered ${response.status}`);

            const placement = Placement.parse(await response.json());
            return { sessionId: placement.sessionId, serverUrl: placement.serverUrl };
        },
    };
}

import {
    Placement,
    REQUEST_ID_HEADER,
    type GameId,
    type PlacementRequest,
    type PlayableVersion,
    type PlayerId,
    type SessionId,
} from '@grove/api-contract';
import type { Env } from './env.js';

/**
 * Where a joining player is sent, the one question the allocator cannot answer itself.
 * Handed to `buildApp` like `Records`, so the router is a dependency rather than a URL.
 */
export interface Fleet {
    place(
        game: GameId,
        player: PlayerId,
        /**
         * The version to join, and the code a box needs to start the session. Decided here, not in
         * the router, which knows only what its boxes run.
         */
        version: PlayableVersion,
        // Passed rather than read off a request, because this seam holds no Fastify types — and a
        // placement the router logged under an id of its own is one no join can be traced into.
        requestId: string,
    ): Promise<{ sessionId: SessionId; serverUrl: string; revision: number } | undefined>;
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
        place: async (game, player, version, requestId) => {
            const response = await fetch(`${env.SERVER_MANAGER_URL}/v1/placements`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${env.FLEET_SECRET}`,
                    [REQUEST_ID_HEADER]: requestId,
                },
                body: JSON.stringify({
                    gameId: game,
                    playerId: player,
                    revision: version.revision,
                    bundles: version.bundles,
                } satisfies PlacementRequest),
                signal: AbortSignal.timeout(PLACEMENT_TIMEOUT_MS),
            });

            if (response.status === 409) return undefined;
            // Anything else is the fleet failing rather than being full: nothing here would hand a
            // player "no capacity" for a router that is simply down.
            if (!response.ok) throw new Error(`server-manager answered ${response.status}`);

            const placement = Placement.parse(await response.json());
            // A session on another version is one whose code this service is about to name wrongly,
            // and a browser handed the wrong bundle set is refused at the handshake — or, declaring
            // no hash, admitted into a world with none of its scripts. Refused as a fleet fault.
            if (placement.revision !== version.revision) {
                throw new Error(
                    `server-manager placed revision ${placement.revision} for a join asking ${version.revision}`,
                );
            }
            return {
                sessionId: placement.sessionId,
                serverUrl: placement.serverUrl,
                // The router's answer rather than the version asked for: a join that landed in a
                // world still draining on an older build is what the browser has to fetch for.
                revision: placement.revision,
            };
        },
    };
}

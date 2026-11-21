import {
    Placement,
    type DeploymentRequest,
    type GameId,
    type PlacementRequest,
    type PlayableVersion,
    type PlayerId,
    type SessionId,
} from '@grove/api-contract';
import { fleetCall } from '@grove/service-kit';
import type { Env } from './env.js';

/** Where a joining player is sent and where a new version is announced: the router's answers. */
export interface Fleet {
    place(
        game: GameId,
        player: PlayerId,
        /** The version to join, decided here, not by a router that knows only what boxes run. */
        version: PlayableVersion,
        // Passed rather than read off a request, so the router logs the join under the player's id.
        requestId: string,
    ): Promise<{ sessionId: SessionId; serverUrl: string; revision: number } | undefined>;
    /** Asks the fleet to drain a game's worlds on any other version; throws if it is not taken. */
    deploy(game: GameId, version: PlayableVersion, requestId: string): Promise<void>;
}

/** The fleet seam with nothing behind it: no box to put a session on, which a join makes a 409. */
export const unattachedFleet: Fleet = {
    place: async () => undefined,
    deploy: async () => undefined,
};

/** The router could not answer in time, which the error handler makes a 503 a player retries. */
export class FleetUnavailable extends Error {
    readonly statusCode = 503;
    /** The router's own answer, since a cold box is usually warm a second later. */
    readonly retryAfterS = 1;

    constructor(status: number) {
        super(`server-manager answered ${status}`);
        this.name = 'FleetUnavailable';
    }
}

/** Two seconds, because every join waits behind this call. */
const PLACEMENT_TIMEOUT_MS = 2_000;

/** A deployment fans out to every box holding the game, which is slower than one placement. */
const DEPLOYMENT_TIMEOUT_MS = 10_000;

/** The fleet router over HTTP, behind the secret its api-facing routes compare. */
export function httpFleet(env: Env): Fleet {
    const call = fleetCall({
        baseUrl: env.SERVER_MANAGER_URL,
        secret: env.SERVER_MANAGER_SECRET,
        timeoutMs: PLACEMENT_TIMEOUT_MS,
    });
    return {
        place: async (game, player, version, requestId) => {
            const response = await call('/v1/placements', requestId, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    gameId: game,
                    playerId: player,
                    revision: version.revision,
                    bundles: version.bundles,
                } satisfies PlacementRequest),
            });

            if (response.status === 409) return undefined;
            // A cold box or a router still warming up: never full, and likely placed on a retry.
            if (response.status === 503) throw new FleetUnavailable(response.status);
            // Anything else is the fleet failing, which no player should be told is a full fleet.
            if (!response.ok) throw new Error(`server-manager answered ${response.status}`);

            const placement = Placement.parse(await response.json());
            // Another version is a fleet fault: the joiner would claim an identity the world lacks.
            if (placement.revision !== version.revision) {
                throw new Error(
                    `server-manager placed revision ${placement.revision} for a join asking ${version.revision}`,
                );
            }
            return {
                sessionId: placement.sessionId,
                serverUrl: placement.serverUrl,
                revision: placement.revision,
            };
        },

        deploy: async (game, version, requestId) => {
            const response = await call('/v1/deployments', requestId, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    gameId: game,
                    revision: version.revision,
                    bundles: version.bundles,
                    regions: [],
                } satisfies DeploymentRequest),
                timeoutMs: DEPLOYMENT_TIMEOUT_MS,
            });
            if (!response.ok) throw new Error(`server-manager answered ${response.status}`);
        },
    };
}

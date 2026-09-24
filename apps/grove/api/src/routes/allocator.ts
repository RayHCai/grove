import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayRequestParams, PlaySession } from '@grove/api-contract';
import { signSessionToken } from '@grove/api-contract/tokens';
import type { Env } from '../env.js';
import type { Fleet } from '../fleet.js';
import type { Records } from '../records.js';
import { requireCsrfToken, requireSession } from '../session.js';

const TICKET_LIFETIME_SECONDS = 60;

/**
 * Where a browser asks to play, and the only thing that mints a game-scoped token.
 * `requireGameOwner` is absent on purpose: the game's own visibility stands in its place.
 */
export function allocatorRoutes(env: Env, records: Records, fleet: Fleet): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));

        app.post(
            '/games/:gameId/play',
            {
                schema: {
                    tags: ['allocator'],
                    params: PlayRequestParams,
                    response: {
                        200: PlaySession,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const game = await records.gameOf(request.params.gameId);
                // One answer for a missing game and a private one somebody else owns: a 403 on the
                // second would confirm the id names a real game.
                if (
                    game === undefined ||
                    (game.visibility === 'private' && game.ownerId !== request.viewer.playerId)
                ) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }

                // The newest build that finished, never the newest publish: a revision that failed
                // to compile, or is still compiling, is one no box can be asked to run.
                const version = await records.playableVersionOf(request.params.gameId);
                if (version === undefined) {
                    return reply.code(409).send({ code: 'conflict', message: 'no playable build' });
                }

                const placement = await fleet.place(
                    request.params.gameId,
                    request.viewer.playerId,
                    version,
                    request.id,
                );
                if (placement === undefined) {
                    return reply.code(409).send({ code: 'conflict', message: 'no capacity' });
                }

                const exp = Math.floor(Date.now() / 1000) + TICKET_LIFETIME_SECONDS;
                return reply.send({
                    sessionId: placement.sessionId,
                    serverUrl: placement.serverUrl,
                    ticket: signSessionToken(
                        {
                            gameId: request.params.gameId,
                            sessionId: placement.sessionId,
                            // From the cookie session, never from the request: the game host trusts
                            // whatever this names, and it reaches every other peer as `player.id`.
                            playerId: request.viewer.playerId,
                            aud: 'game-instance',
                            exp,
                        },
                        env.GAME_TOKEN_SECRET,
                    ),
                    expiresAt: new Date(exp * 1000).toISOString(),
                    // What the session placed is running, so the browser fetches that version's
                    // code rather than whatever this service built most recently.
                    revision: placement.revision,
                    // What a joiner has to claim to be admitted. The code it runs is the Welcome's
                    // to name, so nothing about a bundle crosses here.
                    projectId: version.projectId,
                    projectHash: version.projectHash,
                });
            },
        );
    };
}

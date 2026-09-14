import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayRequestParams, PlaySession, signSessionToken } from '@grove/api-contract';
import type { Env } from '../env.js';
import type { Fleet } from '../fleet.js';
import { requireCsrfToken, requireSession } from '../session.js';

const TICKET_LIFETIME_SECONDS = 60;

/**
 * Where a browser asks to play, and the only thing that mints a game-scoped token.
 *
 * It takes the two gates a cookie-authenticated write needs and nothing else. No friend graph, no
 * block list, no multipart parser — this is the hot path into a game, and it inherits none of what
 * the sibling scopes needed.
 */
export function allocatorRoutes(env: Env, fleet: Fleet): FastifyPluginAsyncZod {
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
                        409: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const placement = await fleet.place(
                    request.params.gameId,
                    request.viewer.playerId,
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
                });
            },
        );
    };
}

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    ErrorBody,
    PlayRequestParams,
    PlaySession,
    signSessionToken,
    type GameId,
    type SessionId,
} from '@grove/api-contract';
import type { Env } from '../env.js';
import { requireSession } from '../session.js';

const TICKET_LIFETIME_SECONDS = 60;

/**
 * Where a browser asks to play, and the only thing that mints a game-scoped token.
 *
 * It takes `requireSession` and nothing else. No friend graph, no block list, no multipart parser —
 * this is the hot path into a game, and it inherits none of what the sibling scopes needed.
 */
export function allocatorRoutes(env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);

        app.post(
            '/games/:gameId/play',
            {
                schema: {
                    tags: ['allocator'],
                    params: PlayRequestParams,
                    response: { 200: PlaySession, 401: ErrorBody, 409: ErrorBody },
                },
            },
            async (request, reply) => {
                const placement = await placeSession(request.params.gameId);
                if (placement === undefined) {
                    return reply.code(409).send({ code: 'conflict', message: 'no capacity' });
                }

                const exp = Math.floor(Date.now() / 1000) + TICKET_LIFETIME_SECONDS;
                return reply.send({
                    sessionId: placement.sessionId,
                    serverUrl: placement.serverUrl,
                    ticket: signSessionToken(
                        { gameId: request.params.gameId, sessionId: placement.sessionId, exp },
                        env.GAME_TOKEN_SECRET,
                    ),
                    expiresAt: new Date(exp * 1000).toISOString(),
                });
            },
        );
    };
}

async function placeSession(
    _game: GameId,
): Promise<{ sessionId: SessionId; serverUrl: string } | undefined> {
    return undefined;
}

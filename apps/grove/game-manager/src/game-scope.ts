import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken } from '@grove/api-contract';
import type { GameId, SessionId } from '@grove/api-contract';
import type { Env } from './env.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** The game this request may touch. Set by the scope hook, never read from the URL. */
        gameId: GameId;
        sessionId: SessionId;
    }
}

/**
 * The one check this service has, and the reason it is a scope hook rather than a call in each
 * handler: a route added to the scope is covered by construction, and forgetting it is not
 * something a new route can do.
 *
 * `gameId` comes off the verified token, so a request cannot name a game it was not issued for —
 * cross-game access is unrepresentable rather than merely rejected.
 */
export function verifyGameToken(env: Env) {
    return async function hook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const header = request.headers.authorization;
        if (header === undefined || !header.startsWith('Bearer ')) {
            await reply.code(401).send({ code: 'unauthorized', message: 'no token' });
            return;
        }

        const result = verifySessionToken(
            header.slice('Bearer '.length),
            env.GAME_TOKEN_SECRET,
            Math.floor(Date.now() / 1000),
        );

        if (!result.ok) {
            request.log.warn({ reason: result.reason }, 'token refused');
            await reply.code(401).send({ code: 'unauthorized', message: result.reason });
            return;
        }

        request.gameId = result.claims.gameId;
        request.sessionId = result.claims.sessionId;
    };
}

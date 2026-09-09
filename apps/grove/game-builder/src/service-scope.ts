import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from './env.js';

/**
 * The one check this service has, and the reason it is a scope hook rather than a call in each
 * handler: a route added to the scope is covered by construction, and forgetting it is not
 * something a new route can do.
 *
 * A shared fleet bearer and not a session token — `@grove/api` calls this service on a creator's
 * behalf, so there is no game process and no session for a token to be scoped to.
 */
export function verifyFleetSecret(env: Env) {
    const expected = Buffer.from(env.FLEET_SECRET, 'utf8');

    return async function hook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const header = request.headers.authorization;
        if (header === undefined || !header.startsWith('Bearer ')) {
            await reply.code(401).send({ code: 'unauthorized', message: 'no bearer' });
            return;
        }

        const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');

        // Length first: `timingSafeEqual` throws rather than returning false on a mismatch, and a
        // length is already public in the way the bytes are not.
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
            request.log.warn('bearer refused');
            await reply.code(401).send({ code: 'unauthorized', message: 'bad bearer' });
            return;
        }
    };
}

import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayerId } from '@grove/api-contract';

/**
 * The only scope with no session requirement — signing in is what produces one.
 *
 * Its rate limit is its own and much tighter than the app's: this is where credential stuffing
 * lands, and a limit shared with the read routes would have to be loose enough to be useless here.
 */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
    await app.register(import('@fastify/rate-limit'), {
        max: 10,
        timeWindow: '1 minute',
    });

    app.post(
        '/sessions',
        {
            schema: {
                tags: ['auth'],
                body: z.object({ email: z.email(), password: z.string().min(1) }),
                response: {
                    200: z.object({ playerId: PlayerId }),
                    401: ErrorBody,
                },
            },
        },
        async (request, reply) => {
            const playerId = await signIn(request.body.email, request.body.password);
            if (playerId === undefined) {
                return reply.code(401).send({ code: 'unauthorized', message: 'no such account' });
            }

            // Rotate before writing identity into it, or a session fixed by an attacker before the
            // login survives it.
            await request.session.regenerate();
            request.session.playerId = playerId;
            return reply.send({ playerId });
        },
    );

    app.delete('/sessions/current', { schema: { tags: ['auth'] } }, async (request, reply) => {
        await request.session.destroy();
        return reply.code(204).send();
    });
};

async function signIn(_email: string, _password: string): Promise<PlayerId | undefined> {
    return undefined;
}

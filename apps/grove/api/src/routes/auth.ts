import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayerId } from '@grove/api-contract';
import type { Records } from '../records.js';
import { requireCsrfToken, requireSession } from '../session.js';

/** Who the caller is, and the token their next write has to carry. */
const SignedIn = z.object({ playerId: PlayerId, csrfToken: z.string() });

/**
 * Where a session begins and ends.
 *
 * Nothing at this level demands one — signing in is what produces it, and the CSRF token the other
 * scopes demand comes back with it — so the two routes that do sit in a child scope below.
 *
 * Its rate limit is its own and much tighter than the app's: this is where credential stuffing
 * lands, and a limit shared with the read routes would have to be loose enough to be useless here.
 */
export function authRoutes(records: Records): FastifyPluginAsyncZod {
    return async (app) => {
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
                        200: SignedIn,
                        401: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const playerId = await records.signIn(request.body.email, request.body.password);
                if (playerId === undefined) {
                    return reply
                        .code(401)
                        .send({ code: 'unauthorized', message: 'no such account' });
                }

                const abandoned = request.session.sessionId;
                // Rotate before writing identity into it, or a session fixed by an attacker before
                // the login survives it.
                await request.session.regenerate();
                // The rotation stores the new id and leaves the old one holding this account, so a
                // cookie stolen before this sign-in would answer for it until the day was out.
                await forget(request, abandoned);
                request.session.playerId = playerId;
                // Minted after the rotation and never carried across it: a secret planted before
                // the login would otherwise verify a token the planter already holds.
                return reply.send({ playerId, csrfToken: reply.generateCsrf() });
            },
        );

        await app.register(signedInAuthRoutes);
    };
}

/**
 * The two auth routes a session already answers for.
 *
 * A child scope rather than hooks on single routes: minting a token is what an anonymous caller
 * must not reach, and ending a session is a write like any other, while the sign-in that hands
 * both out stays in the parent with neither gate.
 */
const signedInAuthRoutes: FastifyPluginAsyncZod = async (app) => {
    app.addHook('onRequest', requireSession);
    app.addHook('onRequest', requireCsrfToken(app));

    app.get(
        '/session',
        { schema: { tags: ['auth'], response: { 200: SignedIn, 401: ErrorBody } } },
        async (request, reply) =>
            // Reuses the secret already in the session, so a token handed out earlier stays good.
            reply.send({ playerId: request.viewer.playerId, csrfToken: reply.generateCsrf() }),
    );

    app.delete(
        '/sessions/current',
        { schema: { tags: ['auth'], response: { 204: z.null(), 401: ErrorBody, 403: ErrorBody } } },
        async (request, reply) => {
            await request.session.destroy();
            return reply.code(204).send(null);
        },
    );
};

/** The store is the only handle left on a session the plugin has already stopped tracking. */
async function forget(request: FastifyRequest, sessionId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        request.sessionStore.destroy(sessionId, (error) => (error ? reject(error) : resolve()));
    });
}

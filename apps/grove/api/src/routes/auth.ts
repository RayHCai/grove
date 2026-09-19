import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, SignedIn } from '@grove/api-contract';
import type { Env } from '../env.js';
import { resetLink } from '../mailer.js';
import type { Mailer } from '../mailer.js';
import type { Records } from '../records.js';
import { beginSession, requireCsrfToken, requireSession } from '../session.js';
import type { ExpiringSessionStore } from '../session-store.js';
import { Email, Password } from '../values.js';

/**
 * Where a session begins and ends; nothing at this level demands one, so the two routes that do
 * sit in a child scope. Its rate limit is its own: this is where credential stuffing lands.
 */
export function authRoutes(
    records: Records,
    mailer: Mailer,
    sessions: ExpiringSessionStore,
    env: Env,
): FastifyPluginAsyncZod {
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
                    // Bounded on both fields: unbounded, the only ceiling is Fastify's 1 MiB body,
                    // and an address nobody could have registered still costs a lookup.
                    body: z.object({ email: Email, password: z.string().min(1).max(128) }),
                    response: {
                        200: SignedIn,
                        401: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const playerId = await records.signIn(request.body.email, request.body.password);
                // One answer for an unknown address, a wrong password and a locked account: which
                // of the three it was is the fact an enumeration is looking for.
                if (playerId === undefined) {
                    return reply
                        .code(401)
                        .send({ code: 'unauthorized', message: 'no such account' });
                }

                const csrfToken = await beginSession(request, reply, playerId);
                return reply.send({ playerId, csrfToken });
            },
        );

        app.post(
            '/password-resets',
            {
                schema: {
                    tags: ['auth'],
                    body: z.object({ email: Email }),
                    response: { 202: z.null(), 400: ErrorBody, 429: ErrorBody, 501: ErrorBody },
                },
            },
            async (request, reply) => {
                const begun = await records.beginPasswordReset(request.body.email);
                if (begun.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }

                if (begun.outcome === 'begun') {
                    const sent = await mailer.sendPasswordReset(
                        begun.email,
                        resetLink(env, begun.token),
                    );
                    if (sent.outcome === 'unattached') {
                        return reply
                            .code(501)
                            .send({ code: 'internal', message: 'no mailer is attached' });
                    }
                    // A provider that refused this one message is this service's problem, not the
                    // caller's, and saying so would answer the question the 202 exists to refuse.
                    if (sent.outcome === 'failed') {
                        request.log.error('password reset mail was not delivered');
                    }
                }

                // The same answer whether or not that address has an account. This route is
                // unauthenticated, and which addresses are registered is not its to tell.
                return reply.code(202).send(null);
            },
        );

        app.put(
            '/password',
            {
                schema: {
                    tags: ['auth'],
                    // The key travels in the body rather than the path: a URL reaches logs, proxies
                    // and `Referer` headers, and this one is a password until it is spent.
                    body: z.object({ token: z.string().min(1).max(256), newPassword: Password }),
                    response: { 204: z.null(), 400: ErrorBody, 401: ErrorBody, 501: ErrorBody },
                },
            },
            async (request, reply) => {
                const finished = await records.finishPasswordReset(
                    request.body.token,
                    request.body.newPassword,
                );
                if (finished.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }
                // Wrong, already spent, and expired are one answer: a caller holding a key learns
                // only that it does not open anything.
                if (finished.outcome === 'refused') {
                    return reply
                        .code(401)
                        .send({ code: 'unauthorized', message: 'that link is no longer good' });
                }

                // Whoever reset the password is not signed in by it, and every session the account
                // was holding ends — a reset is what somebody does when they think it was stolen.
                sessions.destroyFor(finished.player);
                return reply.code(204).send(null);
            },
        );

        await app.register(signedInAuthRoutes);
    };
}

/**
 * The auth routes a session already answers for. A child scope rather than per-route hooks:
 * handing out another CSRF token is what an anonymous caller must not reach.
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
        {
            schema: {
                tags: ['auth'],
                response: { 204: z.null(), 401: ErrorBody, 403: ErrorBody },
            },
        },
        async (request, reply) => {
            await request.session.destroy();
            return reply.code(204).send(null);
        },
    );
};

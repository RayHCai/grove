import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, SignedIn } from '@grove/api-contract';
import type { Env } from '../env.js';
import type { CredentialLimits } from '../limits.js';
import { resetLink } from '../mailer.js';
import type { Mailer } from '../mailer.js';
import type { Accounts } from '../records.js';
import { beginSession, requireSignedIn } from '../session.js';
import type { Sessions } from '../sessions.js';
import { Email, Password } from '../values.js';
import { unattached } from '../reply.js';

export interface AuthDeps {
    accounts: Accounts;
    mailer: Mailer;
    sessions: Sessions;
    credentials: CredentialLimits;
    env: Env;
}

/** Off the general budget, since the two credential hooks below stand in for it. */
const CREDENTIAL_ROUTE = { rateLimit: false } as const;

/** Where a session begins and ends; a route taking a credential carries two limits of its own. */
export function authRoutes({
    accounts,
    mailer,
    sessions,
    credentials,
    env,
}: AuthDeps): FastifyPluginAsyncZod {
    return async (app) => {
        app.post(
            '/sessions',
            {
                config: CREDENTIAL_ROUTE,
                onRequest: credentials.perAddress,
                preHandler: credentials.perAccount,
                schema: {
                    tags: ['auth'],
                    // Bounded: an address nobody could have registered still costs a lookup.
                    body: z.object({ email: Email, password: z.string().min(1).max(128) }),
                    response: {
                        200: SignedIn,
                        401: ErrorBody,
                        429: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const playerId = await accounts.signIn(request.body.email, request.body.password);
                // One answer for an unknown address, a wrong password and a locked account.
                if (playerId === undefined) {
                    return reply
                        .code(401)
                        .send({ code: 'unauthorized', message: 'no such account' });
                }

                const csrfToken = await beginSession(request, reply, playerId, sessions);
                return reply.send({ playerId, csrfToken });
            },
        );

        app.post(
            '/password-resets',
            {
                config: CREDENTIAL_ROUTE,
                onRequest: credentials.perAddress,
                preHandler: credentials.perAccount,
                schema: {
                    tags: ['auth'],
                    body: z.object({ email: Email }),
                    response: { 202: z.null(), 400: ErrorBody, 429: ErrorBody, 501: ErrorBody },
                },
            },
            async (request, reply) => {
                const begun = await accounts.beginPasswordReset(request.body.email);
                if (begun.outcome === 'unattached') {
                    return unattached(reply, 'account store');
                }
                if (begun.outcome === 'throttled') {
                    request.log.info('password reset mail withheld: this address had its share');
                }

                if (begun.outcome === 'begun') {
                    const sent = await mailer.sendPasswordReset(
                        begun.email,
                        resetLink(env, begun.token),
                    );
                    if (sent.outcome === 'unattached') {
                        return unattached(reply, 'mailer');
                    }
                    // A provider refusing one message is this service's problem, not the caller's.
                    if (sent.outcome === 'failed') {
                        request.log.error('password reset mail was not delivered');
                    }
                }

                // One answer whether or not the address has an account, or has been mailed lately.
                return reply.code(202).send(null);
            },
        );

        app.put(
            '/password',
            {
                schema: {
                    tags: ['auth'],
                    // In the body rather than the path: a URL reaches logs, proxies and `Referer`.
                    body: z.object({ token: z.string().min(1).max(256), newPassword: Password }),
                    response: { 204: z.null(), 400: ErrorBody, 401: ErrorBody, 501: ErrorBody },
                },
            },
            async (request, reply) => {
                const finished = await accounts.finishPasswordReset(
                    request.body.token,
                    request.body.newPassword,
                );
                if (finished.outcome === 'unattached') {
                    return unattached(reply, 'account store');
                }
                // Wrong, already spent, and expired are one answer.
                if (finished.outcome === 'refused') {
                    return reply
                        .code(401)
                        .send({ code: 'unauthorized', message: 'that link is no longer good' });
                }

                // Nobody is signed in by it, and every session the account held ends.
                await sessions.destroyFor(finished.player);
                return reply.code(204).send(null);
            },
        );

        await app.register(signedInAuthRoutes);
    };
}

/** The auth routes a session answers for, in a child scope no anonymous caller reaches. */
const signedInAuthRoutes: FastifyPluginAsyncZod = async (app) => {
    requireSignedIn(app);

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

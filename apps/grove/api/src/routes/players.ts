import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Account, ErrorBody, PlayerId, Profile, SignedIn } from '@grove/api-contract';
import type { Records } from '../records.js';
import { beginSession, requireCsrfToken, requireSession } from '../session.js';
import type { ExpiringSessionStore } from '../session-store.js';
import { DisplayName, Email, Password } from '../values.js';

/**
 * Accounts: signing up, and the four things the holder of one may do to it.
 *
 * Sign-up sits in the parent with no session gate and a limiter of its own, because it is the one
 * route here an anonymous caller reaches. Everything else is in the child scope below, behind a
 * cookie — and the limiter stays off that scope deliberately: a shared 10/minute budget would
 * ration reading a profile at the rate credential stuffing deserves.
 */
export function playerRoutes(
    records: Records,
    sessions: ExpiringSessionStore,
): FastifyPluginAsyncZod {
    return async (app) => {
        app.post(
            '/players',
            {
                // Per route rather than per scope: this is the only credential path in the parent.
                config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
                schema: {
                    tags: ['accounts'],
                    body: z.object({
                        email: Email,
                        password: Password,
                        displayName: DisplayName,
                    }),
                    response: {
                        201: SignedIn,
                        400: ErrorBody,
                        409: ErrorBody,
                        429: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const created = await records.createAccount(
                    request.body.email,
                    request.body.password,
                    request.body.displayName,
                );
                if (created.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }
                // An address that already answers to somebody is the one fact this route cannot
                // hide: there is no mailer to defer the answer to.
                if (created.outcome === 'taken') {
                    return reply
                        .code(409)
                        .send({ code: 'conflict', message: 'that address already has an account' });
                }

                const csrfToken = await beginSession(request, reply, created.account.playerId);
                return reply.code(201).send({ playerId: created.account.playerId, csrfToken });
            },
        );

        await app.register(heldAccountRoutes(records, sessions));
    };
}

function heldAccountRoutes(
    records: Records,
    sessions: ExpiringSessionStore,
): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));

        app.get(
            '/players/me',
            {
                schema: {
                    tags: ['accounts'],
                    response: { 200: Account, 401: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const account = await records.accountOf(request.viewer.playerId);
                if (account === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such account' });
                }
                return reply.send(account);
            },
        );

        app.patch(
            '/players/me',
            {
                schema: {
                    tags: ['accounts'],
                    body: z.object({ displayName: DisplayName }),
                    response: {
                        200: Account,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const renamed = await records.renameAccount(
                    request.viewer.playerId,
                    request.body.displayName,
                );
                if (renamed.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }
                if (renamed.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such account' });
                }
                return reply.send(renamed.account);
            },
        );

        app.put(
            '/players/me/password',
            {
                schema: {
                    tags: ['accounts'],
                    // The current one is required: a challenge a caller may decline by leaving a
                    // field out is not a challenge. Somebody who cannot answer it resets instead,
                    // which proves the address rather than the password.
                    body: z.object({ currentPassword: z.string().max(128), newPassword: Password }),
                    // `SignedIn`, not an empty 204: the rotation below drops the CSRF secret with
                    // the old session, so a caller handed nothing back would 403 on every write
                    // until it thought to re-read `GET /v1/auth/session`.
                    response: {
                        200: SignedIn,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const changed = await records.changePassword(
                    request.viewer.playerId,
                    request.body.currentPassword,
                    request.body.newPassword,
                );
                if (changed.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }
                if (changed.outcome === 'wrong_password') {
                    return reply.code(403).send({ code: 'forbidden', message: 'wrong password' });
                }

                // Every other session this account holds is one a stolen password opened, which is
                // what changing it is meant to end. The caller's own goes too, and is replaced.
                sessions.destroyFor(request.viewer.playerId);
                const csrfToken = await beginSession(request, reply, request.viewer.playerId);
                return reply.send({ playerId: request.viewer.playerId, csrfToken });
            },
        );

        app.delete(
            '/players/me',
            {
                schema: {
                    tags: ['accounts'],
                    // Required, not optional: every account has a password, so closing one is a
                    // thing its holder can always prove they may do.
                    body: z.object({ currentPassword: z.string().max(128) }),
                    response: {
                        204: z.null(),
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        409: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const closed = await records.closeAccount(
                    request.viewer.playerId,
                    request.body.currentPassword,
                );
                if (closed.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no account store is attached' });
                }
                if (closed.outcome === 'wrong_password') {
                    return reply.code(403).send({ code: 'forbidden', message: 'wrong password' });
                }
                // The games are Restrict, and their bundles and leaderboard rows live in services
                // this one cannot reach. Deleting the row would orphan all of it.
                if (closed.outcome === 'owns_games') {
                    return reply
                        .code(409)
                        .send({ code: 'conflict', message: 'delete your games first' });
                }

                sessions.destroyFor(request.viewer.playerId);
                // The plugin's rolling save writes a live session back on the way out, so the
                // request's own has to be destroyed rather than only evicted from the store.
                await request.session.destroy();
                return reply.code(204).send(null);
            },
        );

        app.get(
            '/players/:playerId',
            {
                schema: {
                    tags: ['accounts'],
                    params: z.object({ playerId: PlayerId }),
                    response: { 200: Profile, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const profile = await records.profileOf(request.params.playerId);
                if (profile === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such account' });
                }
                return reply.send(profile);
            },
        );
    };
}

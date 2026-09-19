import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, Game, GameId, GameUpdate } from '@grove/api-contract';
import type { Records } from '../records.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';
import { GameTitle } from '../values.js';

/**
 * Creating a game, and listing the ones a creator already made.
 *
 * Neither route carries a `:gameId`, which is why `requireGameOwner` is absent here: that hook is a
 * scope preHandler reading the path parameter, and on a scope holding a create it would ask who
 * owns `undefined` and refuse the route to everybody. The routes that do take an id live in
 * `publishingRoutes`, which registers the hook for itself.
 */
export function gameRoutes(records: Records): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));

        app.post(
            '/games',
            {
                schema: {
                    tags: ['games'],
                    body: z.object({ title: GameTitle }),
                    response: {
                        201: Game,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const created = await records.createGame(
                    request.viewer.playerId,
                    request.body.title,
                );
                if (created.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no game store is attached' });
                }
                return reply.code(201).send(created.game);
            },
        );

        app.get(
            '/games',
            {
                schema: {
                    tags: ['games'],
                    response: { 200: z.array(Game), 401: ErrorBody },
                },
            },
            async (request) => records.gamesOf(request.viewer.playerId),
        );
    };
}

/**
 * Changing a game a creator already owns, which today is who may play it.
 *
 * A scope of its own rather than a third route above, because it takes the `:gameId` those two do
 * not and so needs the ownership hook they must not have.
 */
export function gameSettingsRoutes(records: Records): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

        app.patch(
            '/games/:gameId',
            {
                schema: {
                    tags: ['games'],
                    params: z.object({ gameId: GameId }),
                    body: GameUpdate,
                    response: {
                        200: Game,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                // Publishing a game is not what makes it reachable, and neither is building one:
                // this is the only write that does, and it is the owner's alone.
                if (request.body.visibility === undefined) {
                    const game = await records.gameOf(request.params.gameId);
                    if (game === undefined) {
                        return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                    }
                    return reply.send(game);
                }

                const updated = await records.setVisibility(
                    request.params.gameId,
                    request.body.visibility,
                );
                if (updated.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                if (updated.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no game store is attached' });
                }
                return reply.send(updated.game);
            },
        );
    };
}

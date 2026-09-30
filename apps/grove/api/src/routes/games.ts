import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, Game, GameId, GameUpdate } from '@grove/api-contract';
import type { Records } from '../records.js';
import type { Storage } from '../storage.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import { GameTitle } from '../values.js';
import { unattached } from '../reply.js';

/**
 * Creating a game, and listing the ones a creator already made.
 *
 * Neither route carries a `:gameId`, which is why `requireGameOwner` is absent here: that hook is a
 * scope preHandler reading the path parameter, and on a scope holding a create it would ask who
 * owns `undefined` and refuse the route to everybody. The routes that do take an id live in
 * `gameSettingsRoutes`, which registers the hook for itself.
 */
export function gameRoutes(records: Records): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);

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
                    return unattached(reply, 'game store');
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
 * Changing or deleting a game a creator already owns.
 *
 * A scope of its own rather than more routes above, because these take the `:gameId` those two do
 * not and so need the ownership hook they must not have.
 */
export function gameSettingsRoutes(records: Records, storage: Storage): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
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
                    return unattached(reply, 'game store');
                }
                return reply.send(updated.game);
            },
        );

        app.delete(
            '/games/:gameId',
            {
                schema: {
                    tags: ['games'],
                    params: z.object({ gameId: GameId }),
                    response: {
                        204: z.null(),
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                // The bucket before the row, so a failed erase leaves a game its owner can delete again.
                const erased = await storage.erase(`${request.params.gameId}/`);
                if (erased.outcome === 'unavailable') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'the game files could not be deleted' });
                }

                const deleted = await records.deleteGame(request.params.gameId);
                if (deleted.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                if (deleted.outcome === 'unattached') {
                    return unattached(reply, 'game store');
                }
                return reply.code(204).send(null);
            },
        );
    };
}

import type { KeyObject } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayRequestParams, PlaySession } from '@grove/api-contract';
import type { Fleet } from '../fleet.js';
import type { Games, Tasks } from '../records.js';
import { requireSignedIn } from '../session.js';
import { play } from '../workflows/play.js';

export interface AllocatorDeps {
    games: Pick<Games, 'gameOf'>;
    tasks: Pick<Tasks, 'playableVersionOf'>;
    fleet: Pick<Fleet, 'place'>;
    signingKey: KeyObject;
}

/** Where a browser asks to play; the game's visibility stands where `requireGameOwner` would. */
export function allocatorRoutes(deps: AllocatorDeps): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);

        app.post(
            '/games/:gameId/play',
            {
                schema: {
                    tags: ['allocator'],
                    params: PlayRequestParams,
                    response: {
                        200: PlaySession,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const played = await play(
                    deps,
                    request.params.gameId,
                    request.viewer.playerId,
                    request.id,
                );
                switch (played.outcome) {
                    case 'placed':
                        return reply.send(played.session);
                    case 'hidden':
                        return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                    case 'unbuilt':
                        return reply
                            .code(409)
                            .send({ code: 'conflict', message: 'no playable build' });
                    case 'full':
                        return reply.code(409).send({ code: 'conflict', message: 'no capacity' });
                }
            },
        );
    };
}

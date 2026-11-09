import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, GameId, PublishedVersion, Task } from '@grove/api-contract';
import type { TaskQueue } from '../queue.js';
import type { Games, Tasks, Workspaces } from '../records.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import { unattached } from '../reply.js';
import { publish } from '../workflows/publishing.js';

export interface PublishingDeps {
    games: Pick<Games, 'ownerOf' | 'markPublished' | 'publishedVersionOf'>;
    workspaces: Pick<Workspaces, 'workspaceOf'>;
    tasks: Pick<Tasks, 'queueBuild'>;
    queue: TaskQueue;
}

/** Turning the saved draft into a version: a build pinned to the revision the last save froze. */
export function publishingRoutes(deps: PublishingDeps): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
        app.addHook('preHandler', requireGameOwner(deps.games));

        app.post(
            '/games/:gameId/versions',
            {
                schema: {
                    tags: ['publishing'],
                    params: z.object({ gameId: GameId }),
                    // Queued, not run: a compile is a build box's minutes, not this service's.
                    response: {
                        202: Task,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const published = await publish(
                    { ...deps, log: request.log },
                    request.params.gameId,
                    request.viewer.playerId,
                );
                switch (published.outcome) {
                    case 'queued':
                    case 'existing':
                        return reply.code(202).send(published.task);
                    case 'missing':
                        return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                    case 'unsaved':
                        return reply
                            .code(409)
                            .send({ code: 'conflict', message: 'save before publishing' });
                    // The paths: told only that something is unverified, a creator can do nothing.
                    case 'unverified':
                        return reply.code(409).send({
                            code: 'conflict',
                            message: `these assets are still being verified: ${published.paths.join(', ')}`,
                        });
                    case 'moved':
                        return reply.code(409).send({
                            code: 'conflict',
                            message: 'the workspace was saved over while publishing; publish again',
                        });
                    case 'unattached':
                        return unattached(reply, 'task store');
                }
            },
        );

        app.get(
            '/games/:gameId/versions/latest',
            {
                schema: {
                    tags: ['publishing'],
                    params: z.object({ gameId: GameId }),
                    response: {
                        200: PublishedVersion,
                        401: ErrorBody,
                        403: ErrorBody,
                        404: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const latest = await deps.games.publishedVersionOf(request.params.gameId);
                if (latest === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'never published' });
                }
                return reply.send(latest);
            },
        );
    };
}

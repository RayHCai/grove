import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, GameId, PublishedVersion, Task } from '@grove/api-contract';
import type { TaskQueue } from '../queue.js';
import type { Records } from '../records.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';

/**
 * Turning the saved draft into a version. A publish carries no body: it writes a build row and
 * pushes its id. The row goes first — a lost push is work a sweeper still finds.
 */
export function publishingRoutes(records: Records, queue: TaskQueue): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

        app.post(
            '/games/:gameId/versions',
            {
                schema: {
                    tags: ['publishing'],
                    params: z.object({ gameId: GameId }),
                    // The build is queued rather than run here: a compile is minutes of CPU on a
                    // build box, and this service is the one replica every browser talks to.
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
                const workspace = await records.workspaceOf(request.params.gameId);
                if (workspace === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                // Revision zero is a game whose editor has never saved. There is a manifest to
                // build only once one save has happened, and a build of nothing is not a version.
                if (workspace.revision === 0) {
                    return reply
                        .code(409)
                        .send({ code: 'conflict', message: 'save before publishing' });
                }

                const queued = await records.queueTask(
                    request.params.gameId,
                    request.viewer.playerId,
                    'BUILD',
                    workspace.revision,
                );
                if (queued.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such game' });
                }
                if (queued.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no task store is attached' });
                }

                // A second publish of a manifest already queued gets the first task back rather
                // than a second build of identical bytes; it is announced again all the same,
                // because the push that would have woken a builder is the part that can go missing.
                const pushed = await queue.push('BUILD', queued.task.taskId);
                if (pushed.outcome !== 'pushed') {
                    request.log.warn(
                        { taskId: queued.task.taskId, outcome: pushed.outcome },
                        'build not announced',
                    );
                }

                // Written after the task exists, never before: a version this service remembers
                // and nothing was ever asked to build is one no creator can ever play.
                if (queued.outcome === 'queued') {
                    await records.markPublished(request.params.gameId, {
                        revision: workspace.revision,
                        publishedAt: new Date().toISOString(),
                    });
                }
                return reply.code(202).send(queued.task);
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
                const latest = await records.publishedVersionOf(request.params.gameId);
                if (latest === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'never published' });
                }
                return reply.send(latest);
            },
        );
    };
}

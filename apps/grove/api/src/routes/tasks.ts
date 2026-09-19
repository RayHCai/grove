import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, GameId, Task, TaskId, TaskStatusUpdate } from '@grove/api-contract';
import type { Env } from '../env.js';
import type { Records } from '../records.js';
import { verifyFleetSecret } from '../service-scope.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';

/**
 * What a creator's editor is watching.
 *
 * Scoped to the game as every other creator-facing route is, so reading a task is reading one of
 * your own: a task id alone says nothing about who queued it.
 */
export function taskRoutes(records: Records): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

        app.get(
            '/games/:gameId/tasks/:taskId',
            {
                schema: {
                    tags: ['tasks'],
                    params: z.object({ gameId: GameId, taskId: TaskId }),
                    response: { 200: Task, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const task = await records.taskOf(request.params.gameId, request.params.taskId);
                if (task === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such task' });
                }
                return reply.send(task);
            },
        );
    };
}

/**
 * Where a worker says what it did.
 *
 * One route for every kind: @grove/game-builder and @grove/upload-service claim from different
 * streams and settle through the same statement, which is what keeps one set of transition rules.
 *
 * The transitions are monotonic — NOT_STARTED to IN_PROGRESS to a terminal state, never backwards
 * — so a message redelivered after a worker already settled it is refused rather than applied.
 */
export function fleetTaskRoutes(records: Records, env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', verifyFleetSecret(env));

        app.patch(
            '/tasks/:taskId',
            {
                schema: {
                    tags: ['tasks'],
                    params: z.object({ taskId: TaskId }),
                    body: TaskStatusUpdate,
                    response: {
                        200: Task,
                        400: ErrorBody,
                        401: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const advanced = await records.advanceTask(request.params.taskId, request.body);
                if (advanced.outcome === 'missing') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such task' });
                }
                // 409 rather than a quiet success: a worker told its attempt was refused stops
                // retrying, where one told it succeeded would go on writing build output.
                if (advanced.outcome === 'backwards') {
                    return reply.code(409).send({
                        code: 'conflict',
                        message: `the task is already ${advanced.task.status}`,
                    });
                }
                request.log.info(
                    { taskId: advanced.task.taskId, status: advanced.task.status },
                    'task advanced',
                );
                return reply.send(advanced.task);
            },
        );
    };
}

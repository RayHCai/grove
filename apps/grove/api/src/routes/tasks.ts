import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    ErrorBody,
    GameId,
    Task,
    TaskId,
    TaskStatusUpdate,
    validRequestId,
} from '@grove/api-contract';
import type { Env } from '../env.js';
import type { Games, Tasks } from '../records.js';
import { KIND_OF, UNLIMITED, admit } from '../service-scope.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import { unattached } from '../reply.js';
import { advanceTask, type AdvanceDeps } from '../workflows/tasks.js';

/** Where a worker may name itself, which is what a claim records as its holder. */
export const WORKER_HEADER = 'x-grove-worker';

/** What a creator's editor is watching, scoped to the game as every creator-facing route is. */
export function taskRoutes(games: Pick<Games, 'ownerOf'>, tasks: Tasks): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
        app.addHook('preHandler', requireGameOwner(games));

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
                const task = await tasks.taskOf(request.params.gameId, request.params.taskId);
                if (task === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such task' });
                }
                return reply.send(task);
            },
        );
    };
}

/** Where a worker claims and settles, each by its own secret and for its own kind of task only. */
export function fleetTaskRoutes(deps: Omit<AdvanceDeps, 'log'>, env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', admit(env, 'builder', 'asset-service'));

        app.patch(
            '/tasks/:taskId',
            {
                config: UNLIMITED,
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
                        501: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const caller = request.caller as keyof typeof KIND_OF;
                const named = request.headers[WORKER_HEADER];
                const advanced = await advanceTask(
                    { ...deps, log: request.log },
                    {
                        taskId: request.params.taskId,
                        // A credential answers for one kind; another kind's id is no task of its.
                        kind: KIND_OF[caller],
                        worker: typeof named === 'string' && validRequestId(named) ? named : caller,
                        update: request.body,
                        requestId: request.id,
                    },
                );
                switch (advanced.outcome) {
                    case 'advanced':
                        request.log.info(
                            { taskId: advanced.task.taskId, status: advanced.task.status },
                            'task advanced',
                        );
                        return reply.send(advanced.task);
                    case 'missing':
                        return reply.code(404).send({ code: 'not_found', message: 'no such task' });
                    // A 409 rather than a quiet success, so a worker told it lost stops retrying.
                    case 'refused':
                        return reply
                            .code(409)
                            .send({ code: 'conflict', message: advanced.message });
                    case 'invalid':
                        return reply
                            .code(400)
                            .send({ code: 'invalid_request', message: advanced.message });
                    case 'unattached':
                        return unattached(reply, 'games bucket');
                }
            },
        );
    };
}

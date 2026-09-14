import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { BuildJob, BuildJobId, BuildRequest, ErrorBody, GameId } from '@grove/api-contract';
import type { JobQueue } from '../pipeline.js';

const JobParams = z.object({ jobId: BuildJobId });
const GameParams = z.object({ gameId: GameId });
const RecentQuery = z.object({ limit: z.coerce.number().int().positive().max(50).default(20) });

/** Queue a build, watch it, call it off, and see what a game has asked for lately. */
export function buildRoutes(queue: JobQueue): FastifyPluginAsyncZod {
    return async (app) => {
        // A third of the box's minute, so one creator's save loop cannot spend all of it. The key is
        // the validated body rather than the bearer, which is one shared value across the fleet, and
        // reading a body is why this runs at `preHandler` instead of with the box-wide limit.
        const perGame = app.createRateLimit({
            max: 10,
            timeWindow: '1 minute',
            keyGenerator: (request) => (request.body as BuildRequest).gameId,
        });

        // 202 rather than 200: the reply is a place in the queue, because a compile runs for
        // minutes and a caller that waited would hold a socket open for every one of them.
        app.post(
            '/builds',
            {
                schema: {
                    tags: ['builds'],
                    body: BuildRequest,
                    response: { 202: BuildJob, 400: ErrorBody, 401: ErrorBody, 429: ErrorBody },
                },
                preHandler: async (request, reply) => {
                    const ration = await perGame(request);
                    if (ration.isAllowed || !ration.isExceeded) return;
                    return reply
                        .code(429)
                        .header('retry-after', ration.ttlInSeconds)
                        .send({ code: 'rate_limited', message: 'too many builds for this game' });
                },
            },
            async (request, reply) => {
                // The 202 carries the job id and the request log does not, so this is the line that
                // ties everything the queue later says about the build to the caller that asked.
                const job = await queue.enqueue(request.body);
                request.log.info({ jobId: job.jobId, gameId: job.gameId }, 'build queued');
                return reply.code(202).send(job);
            },
        );

        // Diagnostics ride on the job instead of on an endpoint of their own, so the editor that is
        // already polling for state has them the moment it learns the build failed.
        app.get(
            '/builds/:jobId',
            {
                schema: {
                    tags: ['builds'],
                    params: JobParams,
                    response: { 200: BuildJob, 401: ErrorBody, 404: ErrorBody },
                },
            },
            async (request, reply) => {
                const job = await queue.get(request.params.jobId);
                if (job === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'no such build' });
                }
                return reply.send(job);
            },
        );

        // A finished build conflicts rather than succeeding quietly: its outcome is settled, and
        // a cancel cannot unsettle it.
        app.delete(
            '/builds/:jobId',
            {
                schema: {
                    tags: ['builds'],
                    params: JobParams,
                    response: {
                        204: z.null(),
                        401: ErrorBody,
                        404: ErrorBody,
                        409: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const outcome = await queue.cancel(request.params.jobId);
                if (outcome === 'unknown') {
                    return reply.code(404).send({ code: 'not_found', message: 'no such build' });
                }
                if (outcome === 'finished') {
                    return reply
                        .code(409)
                        .send({ code: 'conflict', message: 'the build already finished' });
                }
                return reply.code(204).send(null);
            },
        );

        app.get(
            '/games/:gameId/builds',
            {
                schema: {
                    tags: ['builds'],
                    params: GameParams,
                    querystring: RecentQuery,
                    response: { 200: z.array(BuildJob), 400: ErrorBody, 401: ErrorBody },
                },
            },
            async (request, reply) =>
                reply.send(await queue.listForGame(request.params.gameId, request.query.limit)),
        );
    };
}

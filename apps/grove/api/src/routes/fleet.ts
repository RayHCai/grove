import { z } from 'zod';
import { ErrorBody, FleetReport } from '@grove/api-contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Env } from '../env.js';
import type { FleetHistory } from '../records.js';
import { UNLIMITED, admit } from '../service-scope.js';

/** Where @grove/server-manager leaves the fleet's history, which no request path reads. */
export function fleetRoutes(history: FleetHistory, env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', admit(env, 'server-manager'));

        app.post(
            '/fleet/reports',
            {
                config: UNLIMITED,
                schema: {
                    tags: ['fleet'],
                    body: FleetReport,
                    response: { 204: z.null(), 401: ErrorBody },
                },
            },
            async (request, reply) => {
                await history.recordFleet(request.body);
                // Nothing to read: the reporter acts on no part of the answer.
                return reply.code(204).send(null);
            },
        );
    };
}

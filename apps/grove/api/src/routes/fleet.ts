import { z } from 'zod';
import { ErrorBody, FleetReport } from '@grove/api-contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Env } from '../env.js';
import type { Records } from '../records.js';
import { verifyFleetSecret } from '../service-scope.js';

/**
 * Where @grove/server-manager leaves the fleet's history.
 *
 * That service routes off a registry one interval of heartbeats rebuilds, which is what lets it
 * hold the fleet in memory — and what means the state a box *was* in survives nowhere. The rows it
 * posts here are the part no later heartbeat carries.
 *
 * Nothing reads this back on any request path. A report arriving late, twice, or not at all costs
 * the history and never a join.
 */
export function fleetRoutes(records: Records, env: Env): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', verifyFleetSecret(env));

        app.post(
            '/fleet/reports',
            {
                schema: {
                    tags: ['fleet'],
                    body: FleetReport,
                    response: { 204: z.null(), 401: ErrorBody },
                },
            },
            async (request, reply) => {
                await records.recordFleet(request.body);
                // Nothing to read: the reporter acts on no part of the answer, and a body it would
                // drain every interval is bytes across the wire for no reader.
                return reply.code(204).send(null);
            },
        );
    };
}

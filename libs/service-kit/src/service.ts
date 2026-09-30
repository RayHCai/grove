import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { REQUEST_ID_HEADER, validRequestId } from '@grove/api-contract';
import { installErrorHandler } from './errors.js';

/**
 * The correlation id the rest of the fleet already carries: a caller's when it is one token a log
 * can hold unchanged, a fresh one when it is not. Bounded here rather than through
 * `requestIdHeader`, which hands the raw header to the logger unmeasured.
 */
export function requestIdOf(request: IncomingMessage): string {
    const presented = request.headers[REQUEST_ID_HEADER];
    return typeof presented === 'string' && validRequestId(presented) ? presented : randomUUID();
}

/** The Fastify options every service starts with; spread them before a service's own. */
export function serviceOptions(nodeEnv: 'development' | 'test' | 'production') {
    return {
        logger: { level: nodeEnv === 'production' ? 'info' : 'debug' },
        genReqId: requestIdOf,
    };
}

/**
 * The zod codecs, the shared failure shape, and the correlation header on every answer.
 *
 * Install before any route scope, so a refusal from one of their hooks is answered under the same
 * id as the request that earned it.
 */
export function installServiceHandlers(app: FastifyInstance): void {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);
    app.addHook('onSend', async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
    });
}

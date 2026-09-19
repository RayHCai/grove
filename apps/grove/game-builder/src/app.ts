import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { REQUEST_ID_HEADER, validRequestId } from '@grove/api-contract';
import type { Env } from './env.js';
import { installErrorHandler } from './errors.js';

/**
 * One route, because nothing calls this service any more: a build box claims work from a stream
 * and settles it against @grove/api, so what is served here is the liveness a host agent polls.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
        // The correlation id the rest of the fleet already carries: a caller's when it is one token
        // a log can hold unchanged, a fresh one when it is not.
        genReqId: (request) => {
            const presented = request.headers[REQUEST_ID_HEADER];
            return typeof presented === 'string' && validRequestId(presented)
                ? presented
                : randomUUID();
        },
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);

    app.addHook('onSend', async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
    });

    app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

    return app;
}

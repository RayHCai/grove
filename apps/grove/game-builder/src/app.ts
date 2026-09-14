import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
    jsonSchemaTransform,
    serializerCompiler,
    validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { REQUEST_ID_HEADER, validRequestId } from '@grove/api-contract';
import type { Env } from './env.js';
import { installErrorHandler } from './errors.js';
import type { JobQueue } from './pipeline.js';
import { buildRoutes } from './routes/builds.js';
import { verifyFleetSecret } from './service-scope.js';

/**
 * Architecturally a twin of `@grove/game-manager` — same framework, same compilers, same error
 * shape — with a shared fleet bearer instead of a session token, and no browser-facing plugins at
 * all: no CORS, no cookies, no CSRF. Nothing with an origin talks to this service.
 */
export async function buildApp(env: Env, queue: JobQueue): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
        // The correlation id the Go half of the fleet already carries: a caller's when it is one
        // token a log can hold unchanged, a fresh one when it is not. Bounded here rather than
        // through `requestIdHeader`, which hands the raw header to the logger unmeasured.
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

    // Registered before the authenticated scope below, so a bearer this service refuses is refused
    // under the same id as the request that earned it.
    app.addHook('onSend', async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
    });

    // A tenth of what the sibling services allow, since one accepted request buys minutes of a
    // build box's CPU rather than a database round trip. One key for every caller, because the
    // fleet bearer is one value: this bucket is the box's own ceiling, shared with the polls an
    // editor makes while a build runs, and the ration that tells two creators apart sits on the
    // build route, where the game id has been validated.
    await app.register(import('@fastify/rate-limit'), {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: () => 'fleet',
    });

    await app.register(import('@fastify/swagger'), {
        openapi: { info: { title: 'Grove game builder', version: '0.0.0' }, servers: [] },
        transform: jsonSchemaTransform,
    });

    // Polled by the host agent before a bearer exists, so it sits OUTSIDE the authenticated scope —
    // and outside the limit, which rations builds rather than liveness.
    app.get('/health', { schema: { hide: true }, config: { rateLimit: false } }, async () => ({
        ok: true,
    }));

    // One scope, one hook, every build route inside it. A route added here is authenticated because
    // of where it is registered, not because someone remembered to check.
    await app.register(
        async (scope) => {
            scope.addHook('onRequest', verifyFleetSecret(env));
            await scope.register(buildRoutes(queue));
        },
        { prefix: '/v1' },
    );

    return app;
}

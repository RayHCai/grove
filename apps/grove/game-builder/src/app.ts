import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
    jsonSchemaTransform,
    serializerCompiler,
    validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import { installErrorHandler } from './errors.js';
import { InMemoryJobQueue, unattachedToolchain } from './pipeline.js';
import type { JobQueue } from './pipeline.js';
import { buildRoutes } from './routes/builds.js';
import { verifyFleetSecret } from './service-scope.js';

/**
 * Architecturally a twin of `@grove/game-manager` — same framework, same compilers, same error
 * shape — with a shared fleet bearer instead of a session token, and no browser-facing plugins at
 * all: no CORS, no cookies, no CSRF. Nothing with an origin talks to this service.
 */
export async function buildApp(
    env: Env,
    queue: JobQueue = new InMemoryJobQueue(unattachedToolchain),
): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);

    // A tenth of what the sibling services allow, since one accepted request buys minutes of a
    // build box's CPU rather than a database round trip. Keyed by the presented bearer, not the
    // address: every caller sits behind the same fleet network, so an IP-keyed limit would be one
    // bucket for the whole host.
    await app.register(import('@fastify/rate-limit'), {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.headers.authorization ?? request.ip,
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

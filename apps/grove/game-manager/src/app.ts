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
import { verifyGameToken } from './game-scope.js';
import { bundleRoutes } from './routes/bundles.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { stateRoutes } from './routes/state.js';

/**
 * Architecturally a twin of `@grove/api` — same framework, same compilers, same error shape — with
 * one authentication scheme instead of a session, and no browser-facing plugins at all: no CORS, no
 * cookies, no CSRF. Nothing with an origin talks to this service.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);

    // Keyed by the presented token, not the address: every caller sits behind the same fleet
    // network, so an IP-keyed limit would be one bucket for the whole host. It cannot key on
    // `gameId` — this hook runs before the scope's, which is what turns a token into one.
    await app.register(import('@fastify/rate-limit'), {
        max: 600,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.headers.authorization ?? request.ip,
    });

    await app.register(import('@fastify/swagger'), {
        openapi: { info: { title: 'Grove game data', version: '0.0.0' }, servers: [] },
        transform: jsonSchemaTransform,
    });

    // Polled by the host agent before a token exists, so it sits OUTSIDE the authenticated scope.
    app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

    // One scope, one hook, every data route inside it. A route added here is authenticated because
    // of where it is registered, not because someone remembered to check.
    await app.register(
        async (scope) => {
            scope.addHook('onRequest', verifyGameToken(env));
            await scope.register(stateRoutes);
            await scope.register(leaderboardRoutes);
            await scope.register(bundleRoutes);
        },
        { prefix: '/v1' },
    );

    return app;
}

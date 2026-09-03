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
import { allocatorRoutes } from './routes/allocator.js';
import { authRoutes } from './routes/auth.js';
import { publishingRoutes } from './routes/publishing.js';
import { socialRoutes } from './routes/social.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything registered at THIS level is a capability, not a policy: a parser, a codec, a limiter.
 * Nothing here decides who may call what — each route scope adds its own hooks, so a new scope
 * starts closed rather than inheriting whatever its neighbours happened to need.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
        // Behind a load balancer, so the client address for rate limiting comes from the
        // forwarded header rather than from the socket, which would be one proxy for everyone.
        trustProxy: true,
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);

    await app.register(import('@fastify/cors'), {
        // Only origins that hold a logged-in person. The player origin runs creator code and never
        // reaches this service, so letting it send credentials would be handing them away.
        origin: [env.PLATFORM_ORIGIN, env.EDITOR_ORIGIN],
        credentials: true,
    });

    await app.register(import('@fastify/rate-limit'), { max: 300, timeWindow: '1 minute' });

    await app.register(import('@fastify/cookie'));
    await app.register(import('@fastify/session'), {
        secret: env.SESSION_SECRET,
        cookie: {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: env.NODE_ENV === 'production',
            maxAge: ONE_DAY_MS,
        },
    });
    await app.register(import('@fastify/csrf-protection'), { sessionPlugin: '@fastify/session' });

    await app.register(import('@fastify/swagger'), {
        openapi: {
            info: { title: 'Grove API', version: '0.0.0' },
            servers: [],
        },
        transform: jsonSchemaTransform,
    });
    await app.register(import('@fastify/swagger-ui'), { routePrefix: '/docs' });

    app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

    // Four scopes, four different sets of hooks. Sibling scopes share nothing.
    await app.register(authRoutes, { prefix: '/v1/auth' });
    await app.register(socialRoutes, { prefix: '/v1/social' });
    await app.register(publishingRoutes, { prefix: '/v1' });
    await app.register(allocatorRoutes(env), { prefix: '/v1' });

    return app;
}

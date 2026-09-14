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
import { unattachedBuilder } from './builder.js';
import type { Builder } from './builder.js';
import type { Env } from './env.js';
import { installErrorHandler } from './errors.js';
import { unattachedFleet } from './fleet.js';
import type { Fleet } from './fleet.js';
import { unattachedRecords } from './records.js';
import type { Records } from './records.js';
import { allocatorRoutes } from './routes/allocator.js';
import { authRoutes } from './routes/auth.js';
import { publishingRoutes } from './routes/publishing.js';
import { socialRoutes } from './routes/social.js';
import { ExpiringSessionStore } from './session-store.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything registered at THIS level is a capability, not a policy: a parser, a codec, a limiter.
 * Nothing here decides who may call what — each route scope adds its own hooks, so a new scope
 * starts closed rather than inheriting whatever its neighbours happened to need.
 */
export async function buildApp(
    env: Env,
    records: Records = unattachedRecords,
    fleet: Fleet = unattachedFleet,
    builder: Builder = unattachedBuilder,
): Promise<FastifyInstance> {
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
        // Behind a load balancer, so the client address for rate limiting comes from the forwarded
        // header — and only from the peers named here, since everyone else writes it themselves.
        trustProxy: env.TRUSTED_PROXIES,
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);

    // Registered before every scope below, so a refusal from one of their hooks is answered under
    // the same id as the request that earned it.
    app.addHook('onSend', async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
    });

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
        // The plugin's own store keeps every session the process ever made and mints one for
        // callers that never signed in, which on a public service is a leak with a queue at it.
        saveUninitialized: false,
        store: new ExpiringSessionStore(ONE_DAY_MS),
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
    // The spec names every route, parameter and id format of the one service facing the internet,
    // which off this machine is reconnaissance rather than documentation.
    if (env.NODE_ENV !== 'production') {
        await app.register(import('@fastify/swagger-ui'), { routePrefix: '/docs' });
    }

    // Polled by the balancer, so it sits outside the limit, which rations real traffic rather than
    // liveness.
    app.get('/health', { schema: { hide: true }, config: { rateLimit: false } }, async () => ({
        ok: true,
    }));

    // Four scopes, four different sets of hooks. Sibling scopes share nothing.
    await app.register(authRoutes(records), { prefix: '/v1/auth' });
    await app.register(socialRoutes, { prefix: '/v1/social' });
    await app.register(publishingRoutes(records, builder), { prefix: '/v1' });
    await app.register(allocatorRoutes(env, fleet), { prefix: '/v1' });

    return app;
}

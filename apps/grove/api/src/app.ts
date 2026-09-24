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
import { unattachedFleet } from './fleet.js';
import type { Fleet } from './fleet.js';
import { unattachedMailer } from './mailer.js';
import type { Mailer } from './mailer.js';
import { unattachedQueue } from './queue.js';
import type { TaskQueue } from './queue.js';
import { unattachedRecords } from './records.js';
import type { Records } from './records.js';
import { allocatorRoutes } from './routes/allocator.js';
import { assetRoutes } from './routes/assets.js';
import { authRoutes } from './routes/auth.js';
import { fleetBuildRoutes } from './routes/build.js';
import { fleetRoutes } from './routes/fleet.js';
import { gameRoutes, gameSettingsRoutes } from './routes/games.js';
import { playerRoutes } from './routes/players.js';
import { publishingRoutes } from './routes/publishing.js';
import { socialRoutes } from './routes/social.js';
import { fleetTaskRoutes, taskRoutes } from './routes/tasks.js';
import { workspaceRoutes } from './routes/workspace.js';
import { ExpiringSessionStore } from './session-store.js';
import { unattachedSocial } from './social.js';
import type { Social } from './social.js';
import { unattachedStorage } from './storage.js';
import type { Storage } from './storage.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything registered at THIS level is a capability, not a policy: a parser, a codec, a limiter.
 * Each route scope adds its own hooks, so a new scope starts closed.
 */
export async function buildApp(
    env: Env,
    records: Records = unattachedRecords,
    fleet: Fleet = unattachedFleet,
    storage: Storage = unattachedStorage,
    queue: TaskQueue = unattachedQueue,
    mailer: Mailer = unattachedMailer,
    social: Social = unattachedSocial,
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

    // Held rather than constructed inline: a password change and an account close have to reach it
    // to drop the other sessions that account is holding.
    const sessions = new ExpiringSessionStore(ONE_DAY_MS);

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
        // The plugin's own default is GET,HEAD,POST, so a preflight for any write route the
        // editor makes is refused before it is ever routed here.
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });

    await app.register(import('@fastify/rate-limit'), { max: 300, timeWindow: '1 minute' });

    await app.register(import('@fastify/cookie'));
    await app.register(import('@fastify/session'), {
        secret: env.SESSION_SECRET,
        // The plugin's own store keeps every session the process ever made and mints one for
        // callers that never signed in, which on a public service is a leak with a queue at it.
        saveUninitialized: false,
        store: sessions,
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

    // Twelve scopes, twelve sets of hooks. Sibling scopes share nothing, so the fleet's task route
    // can sit beside a creator's without either inheriting the other's gate.
    await app.register(authRoutes(records, mailer, sessions, env), {
        prefix: '/v1/auth',
    });
    await app.register(playerRoutes(records, sessions), { prefix: '/v1' });
    await app.register(gameRoutes(records), { prefix: '/v1' });
    await app.register(gameSettingsRoutes(records), { prefix: '/v1' });
    await app.register(socialRoutes(social), { prefix: '/v1/social' });
    await app.register(workspaceRoutes(records, storage, queue), { prefix: '/v1' });
    await app.register(assetRoutes(records, storage), { prefix: '/v1' });
    await app.register(publishingRoutes(records, queue), { prefix: '/v1' });
    await app.register(taskRoutes(records), { prefix: '/v1' });
    await app.register(fleetTaskRoutes(records, env), { prefix: '/v1' });
    await app.register(fleetBuildRoutes(storage, env), { prefix: '/v1' });
    await app.register(fleetRoutes(records, env), { prefix: '/v1' });
    await app.register(allocatorRoutes(env, records, fleet), { prefix: '/v1' });

    return app;
}
